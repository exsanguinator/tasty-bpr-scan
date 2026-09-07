import csv
import json
import os
import sys
import time

import requests
from dotenv import find_dotenv, load_dotenv

load_dotenv(find_dotenv())

_ENV = os.environ.get("TASTY_ENV", "cert")
BASE_URLS = {
    "prod": "https://api.tastyworks.com",
    "cert": "https://api.cert.tastyworks.com",
}
if _ENV not in BASE_URLS:
    raise ValueError(f"Unknown TASTY_ENV '{_ENV}'. Choose from: {', '.join(BASE_URLS)}")
BASE_URL = BASE_URLS[_ENV]
USER_AGENT = "tasty-sandbox/1.0"

if _ENV != "prod":
    print(
        "This script requires TASTY_ENV=prod: cert has no /market-data/by-type "
        "endpoint, which this script depends on for underlying and option prices.",
        file=sys.stderr,
    )
    sys.exit(1)

print(f"Environment: {_ENV} ({BASE_URL})", file=sys.stderr)

_access_token = None
_token_expires_at = 0


def _fetch_access_token():
    global _access_token, _token_expires_at
    resp = requests.post(
        f"{BASE_URL}/oauth/token",
        headers={"User-Agent": USER_AGENT},
        data={
            "grant_type": "refresh_token",
            "refresh_token": os.environ["TASTY_REFRESH_TOKEN"],
            "client_secret": os.environ["TASTY_CLIENT_SECRET"],
        },
    )
    if not resp.ok:
        raise RuntimeError(f"Token request failed {resp.status_code}: {resp.text}")
    payload = resp.json()
    _access_token = payload["access_token"]
    _token_expires_at = time.time() + payload["expires_in"] - 30
    print("Access token refreshed.", file=sys.stderr)


def _ensure_token():
    if not _access_token or time.time() >= _token_expires_at:
        _fetch_access_token()


def _headers():
    return {
        "Authorization": f"Bearer {_access_token}",
        "User-Agent": USER_AGENT,
    }


def get(path, **params):
    _ensure_token()
    r = requests.get(f"{BASE_URL}{path}", headers=_headers(), params=params)
    if r.status_code == 401:
        _fetch_access_token()
        r = requests.get(f"{BASE_URL}{path}", headers=_headers(), params=params)
    if not r.ok:
        print(f"  URL: {r.url}", file=sys.stderr)
        print(f"  Status: {r.status_code}", file=sys.stderr)
        print(f"  Response: {r.text}", file=sys.stderr)
    r.raise_for_status()
    return r.json()


def post_dry_run(path, body):
    """POST to an orders/dry-run style endpoint. A 422 preflight failure still
    carries a useful buying-power-effect payload (e.g. margin_check_failed just
    means this account can't currently afford the order, not that the request
    was malformed), so this returns the parsed body instead of raising on 422."""
    _ensure_token()
    r = requests.post(f"{BASE_URL}{path}", headers=_headers(), json=body)
    if r.status_code == 401:
        _fetch_access_token()
        r = requests.post(f"{BASE_URL}{path}", headers=_headers(), json=body)
    if r.status_code not in (200, 201, 422):
        print(f"  URL: {r.url}", file=sys.stderr)
        print(f"  Status: {r.status_code}", file=sys.stderr)
        print(f"  Body: {json.dumps(body)}", file=sys.stderr)
        print(f"  Response: {r.text}", file=sys.stderr)
        r.raise_for_status()
    return r.json()


TARGET_DTE = 45


def chunked(seq, size):
    for i in range(0, len(seq), size):
        yield seq[i : i + size]


def load_config(path):
    with open(path) as f:
        return json.load(f)


def resolve_tickers(watchlist_names):
    resp = get("/watchlists")
    wanted = set(watchlist_names)
    tickers = set()
    for item in resp["data"]["items"]:
        if item["name"] not in wanted:
            continue
        for entry in item["watchlist-entries"]:
            if entry["instrument-type"] == "Equity" and not entry["symbol"].endswith(".IVR"):
                tickers.add(entry["symbol"])
    return tickers


def fetch_equity_mids(tickers):
    mids = {}
    ranges = {}
    for chunk in chunked(sorted(tickers), 100):
        resp = get("/market-data/by-type", equity=",".join(chunk))
        for item in resp["data"]["items"]:
            mids[item["symbol"]] = _mid(item)
            year_low = item.get("year-low-price")
            year_high = item.get("year-high-price")
            if year_low is not None and year_high is not None:
                ranges[item["symbol"]] = (float(year_low), float(year_high))
    return mids, ranges


def strike_position_in_52wk_range(strike, year_range):
    """0.0 = strike at the 52-week low, 1.0 = strike at the 52-week high."""
    year_low, year_high = year_range
    if year_high == year_low:
        return None
    return (strike - year_low) / (year_high - year_low)


def fetch_option_mids(symbols):
    mids = {}
    for chunk in chunked(sorted(symbols), 100):
        resp = get("/market-data/by-type", **{"equity-option": ",".join(chunk)})
        for item in resp["data"]["items"]:
            mids[item["symbol"]] = _mid(item)
    return mids


MIN_LIQUIDITY_RATING = 2


def filter_by_liquidity(tickers):
    kept = set()
    for chunk in chunked(sorted(tickers), 100):
        resp = get("/market-metrics", symbols=",".join(chunk))
        for item in resp["data"]["items"]:
            rating = item.get("liquidity-rating")
            if rating is not None and rating >= MIN_LIQUIDITY_RATING:
                kept.add(item["symbol"])
            else:
                print(
                    f"  {item['symbol']}: liquidity-rating {rating} < {MIN_LIQUIDITY_RATING}, skipping",
                    file=sys.stderr,
                )
    return kept


def _mid(item):
    bid = item.get("bid")
    ask = item.get("ask")
    if bid is not None and ask is not None:
        return (float(bid) + float(ask)) / 2
    last = item.get("last")
    return float(last) if last is not None else None


def pick_expiration(expirations):
    regular = [e for e in expirations if e["expiration-type"] == "Regular"]
    candidates = regular or expirations
    return min(candidates, key=lambda e: abs(e["days-to-expiration"] - TARGET_DTE))


def pick_put_strike(expiration, underlying_mid):
    strikes = sorted(expiration["strikes"], key=lambda s: float(s["strike-price"]))
    otm = [s for s in strikes if float(s["strike-price"]) < underlying_mid]
    if not otm:
        return None
    return otm[-1]


def find_candidates(tickers, underlying_mids, underlying_ranges):
    candidates = []
    for ticker in sorted(tickers):
        underlying_mid = underlying_mids.get(ticker)
        if underlying_mid is None:
            print(f"  {ticker}: no underlying quote, skipping", file=sys.stderr)
            continue
        print(f"Fetching option chain for {ticker}...", file=sys.stderr)
        try:
            resp = get(f"/option-chains/{ticker}/nested")
        except requests.HTTPError:
            print(f"  {ticker}: option chain fetch failed, skipping", file=sys.stderr)
            continue
        items = resp["data"]["items"]
        if not items or not items[0]["expirations"]:
            print(f"  {ticker}: no expirations found, skipping", file=sys.stderr)
            continue
        expirations = items[0]["expirations"]
        if not any(e["expiration-type"] == "Weekly" for e in expirations):
            print(f"  {ticker}: no weekly options, skipping", file=sys.stderr)
            continue
        expiration = pick_expiration(expirations)
        strike = pick_put_strike(expiration, underlying_mid)
        if strike is None:
            print(f"  {ticker}: no OTM put strike found, skipping", file=sys.stderr)
            continue
        strike_price = float(strike["strike-price"])
        year_range = underlying_ranges.get(ticker)
        strike_52wk_position = (
            strike_position_in_52wk_range(strike_price, year_range) if year_range else None
        )
        candidates.append(
            {
                "ticker": ticker,
                "expiration": expiration["expiration-date"],
                "dte": expiration["days-to-expiration"],
                "strike": strike_price,
                "put_symbol": strike["put"],
                "strike_52wk_position": strike_52wk_position,
            }
        )
    return candidates


def round_to_nickel(price):
    return round(price / 0.05) * 0.05


def dry_run_order(account_number, put_symbol, price):
    body = {
        "order-type": "Limit",
        "price": f"{round_to_nickel(price):.2f}",
        "price-effect": "Credit",
        "time-in-force": "Day",
        "legs": [
            {
                "instrument-type": "Equity Option",
                "symbol": put_symbol,
                "quantity": "1",
                "action": "Sell to Open",
            }
        ],
    }
    return post_dry_run(f"/accounts/{account_number}/orders/dry-run", body)


def extract_marginal_buying_power(resp, ticker=None, debug=False):
    bpe = resp.get("data", {}).get("buying-power-effect", {})
    errors = resp.get("error", {}).get("errors", [])

    if debug:
        print(f"  [debug] {ticker} dry-run buying-power-effect: {json.dumps(bpe)}", file=sys.stderr)
        if errors:
            print(f"  [debug] {ticker} dry-run errors: {json.dumps(errors)}", file=sys.stderr)

    hard_errors = [e for e in errors if e.get("code") != "margin_check_failed"]
    if hard_errors and not bpe:
        print(f"  {ticker}: preflight error: {hard_errors}", file=sys.stderr)
        return None

    for key in ("isolated-order-margin-requirement", "change-in-buying-power", "change-in-margin-requirement"):
        if key in bpe:
            return abs(float(bpe[key]))
    return None


FIELDNAMES = [
    "ticker",
    "expiration",
    "dte",
    "strike",
    "put_symbol",
    "strike 52wk pct",
    "credit",
    "buying_power",
    "credit to bpr",
    "bpr to notional",
]


def write_csv(rows, out=sys.stdout):
    writer = csv.DictWriter(out, fieldnames=FIELDNAMES)
    writer.writeheader()
    writer.writerows(rows)


def write_html(rows, out=sys.stdout):
    def cell(value):
        return "" if value == "" else str(value)

    header_cells = "".join(f"<th onclick=\"sortTable({i})\">{name}</th>" for i, name in enumerate(FIELDNAMES))
    body_rows = "\n".join(
        "<tr>" + "".join(f"<td>{cell(row[name])}</td>" for name in FIELDNAMES) + "</tr>" for row in rows
    )

    out.write(f"""<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>scan-put-bp results</title>
<style>
  body {{ font-family: sans-serif; font-size: 14px; }}
  table {{ border-collapse: collapse; }}
  th, td {{ border: 1px solid #ccc; padding: 4px 8px; text-align: right; }}
  th:first-child, td:first-child {{ text-align: left; }}
  th {{ cursor: pointer; background: #eee; user-select: none; }}
  th.asc::after {{ content: " \\25B2"; }}
  th.desc::after {{ content: " \\25BC"; }}
</style>
</head>
<body>
<table id="results">
<thead><tr>{header_cells}</tr></thead>
<tbody>
{body_rows}
</tbody>
</table>
<script>
let sortState = {{}};
function sortTable(colIndex) {{
  const table = document.getElementById("results");
  const tbody = table.tBodies[0];
  const rows = Array.from(tbody.rows);
  const ascending = !sortState[colIndex];
  sortState = {{}};
  sortState[colIndex] = ascending;

  rows.sort((a, b) => {{
    const av = a.cells[colIndex].innerText;
    const bv = b.cells[colIndex].innerText;
    const an = parseFloat(av);
    const bn = parseFloat(bv);
    let cmp;
    if (!isNaN(an) && !isNaN(bn)) {{
      cmp = an - bn;
    }} else {{
      cmp = av.localeCompare(bv);
    }}
    return ascending ? cmp : -cmp;
  }});

  for (const row of rows) tbody.appendChild(row);

  for (const th of table.tHead.rows[0].cells) th.classList.remove("asc", "desc");
  table.tHead.rows[0].cells[colIndex].classList.add(ascending ? "asc" : "desc");
}}
</script>
</body>
</html>
""")


if __name__ == "__main__":
    positional_args = [a for a in sys.argv[1:] if not a.startswith("--")]
    config_path = positional_args[0] if positional_args else "margin-scan-config.json"
    config = load_config(config_path)
    account_number = config["account_number"]
    watchlist_names = config["watchlists"]

    tickers = resolve_tickers(watchlist_names)
    print(f"Resolved {len(tickers)} unique tickers: {sorted(tickers)}", file=sys.stderr)

    tickers = filter_by_liquidity(tickers)
    print(f"{len(tickers)} tickers remain after liquidity filter: {sorted(tickers)}", file=sys.stderr)

    underlying_mids, underlying_ranges = fetch_equity_mids(tickers)
    candidates = find_candidates(tickers, underlying_mids, underlying_ranges)

    option_mids = fetch_option_mids([c["put_symbol"] for c in candidates])

    rows = []
    for i, c in enumerate(candidates):
        credit_mid = option_mids.get(c["put_symbol"])
        if credit_mid is None:
            print(f"  {c['ticker']}: no option quote, skipping", file=sys.stderr)
            continue
        print(f"Dry-running {c['ticker']} {c['put_symbol']}...", file=sys.stderr)
        try:
            resp = dry_run_order(account_number, c["put_symbol"], credit_mid)
        except requests.HTTPError:
            print(f"  {c['ticker']}: dry-run failed, skipping", file=sys.stderr)
            continue
        marginal_bp = extract_marginal_buying_power(resp, ticker=c["ticker"], debug=("--debug" in sys.argv))
        if marginal_bp is None:
            print(f"  {c['ticker']}: could not extract margin requirement, skipping", file=sys.stderr)
            continue
        if marginal_bp <= 0:
            print(
                f"  {c['ticker']}: dry-run shows $0 incremental margin requirement "
                f"(account has ample buying-power cushion), skipping from ranking",
                file=sys.stderr,
            )
            continue
        credit = credit_mid * 100
        notional = c["strike"] * 100
        rows.append(
            {
                "ticker": c["ticker"],
                "expiration": c["expiration"],
                "dte": c["dte"],
                "strike": c["strike"],
                "put_symbol": c["put_symbol"],
                "strike 52wk pct": (
                    round(c["strike_52wk_position"], 4)
                    if c["strike_52wk_position"] is not None
                    else ""
                ),
                "credit": round(credit, 2),
                "buying_power": round(marginal_bp, 2),
                "credit to bpr": round(credit / marginal_bp, 4),
                "bpr to notional": round(marginal_bp / notional, 4),
            }
        )

    rows.sort(key=lambda r: r["credit to bpr"], reverse=True)

    if "--html" in sys.argv:
        write_html(rows)
    else:
        write_csv(rows)
