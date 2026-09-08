import csv
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

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
_token_lock = threading.Lock()


def _fetch_access_token():
    """Callers must hold _token_lock: this mutates the shared token globals and
    concurrent workers would otherwise each burn a refresh on the same expiry."""
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
        with _token_lock:
            if not _access_token or time.time() >= _token_expires_at:
                _fetch_access_token()


def _refresh_token_if_stale(stale_auth):
    """Force-refresh after a 401, unless another thread already replaced the
    token this caller used - so a simultaneous 401 storm costs one refresh."""
    with _token_lock:
        if stale_auth == f"Bearer {_access_token}":
            _fetch_access_token()


def _headers():
    return {
        "Authorization": f"Bearer {_access_token}",
        "User-Agent": USER_AGENT,
    }


def get(path, **params):
    _ensure_token()
    headers = _headers()
    r = requests.get(f"{BASE_URL}{path}", headers=headers, params=params)
    if r.status_code == 401:
        _refresh_token_if_stale(headers["Authorization"])
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
    headers = _headers()
    r = requests.post(f"{BASE_URL}{path}", headers=headers, json=body)
    if r.status_code == 401:
        _refresh_token_if_stale(headers["Authorization"])
        r = requests.post(f"{BASE_URL}{path}", headers=_headers(), json=body)
    if r.status_code not in (200, 201, 422):
        print(f"  URL: {r.url}", file=sys.stderr)
        print(f"  Status: {r.status_code}", file=sys.stderr)
        print(f"  Body: {json.dumps(body)}", file=sys.stderr)
        print(f"  Response: {r.text}", file=sys.stderr)
        r.raise_for_status()
    return r.json()


TARGET_DTE = 45

# Both per-ticker loops below are network-bound (one HTTP request per ticker), so
# workers spend their time blocked on the API rather than on the CPU. Capped so a
# many-core machine doesn't run into the API's rate limit.
CONCURRENCY = min(os.cpu_count() or 4, 16)
print(f"Concurrency: {CONCURRENCY} workers", file=sys.stderr)


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
    prev_closes = {}
    for chunk in chunked(sorted(tickers), 100):
        resp = get("/market-data/by-type", equity=",".join(chunk))
        for item in resp["data"]["items"]:
            mids[item["symbol"]] = _mid(item)
            year_low = item.get("year-low-price")
            year_high = item.get("year-high-price")
            if year_low is not None and year_high is not None:
                ranges[item["symbol"]] = (float(year_low), float(year_high))
            prev_close = item.get("prev-close")
            if prev_close is not None:
                prev_closes[item["symbol"]] = float(prev_close)
    return mids, ranges, prev_closes


def strike_position_in_52wk_range(strike, year_range):
    """0.0 = strike at the 52-week low, 1.0 = strike at the 52-week high."""
    year_low, year_high = year_range
    if year_high == year_low:
        return None
    return (strike - year_low) / (year_high - year_low)


def change_from_prev_close(underlying_mid, prev_close):
    """Fraction the underlying's mid has moved from the previous day's close."""
    if prev_close is None or prev_close == 0:
        return None
    return (underlying_mid - prev_close) / prev_close


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
    ivr_by_ticker = {}
    ivx_by_ticker = {}
    for chunk in chunked(sorted(tickers), 100):
        resp = get("/market-metrics", symbols=",".join(chunk))
        for item in resp["data"]["items"]:
            ivr = item.get("implied-volatility-index-rank")
            if ivr is not None:
                ivr_by_ticker[item["symbol"]] = float(ivr)
            ivx = item.get("implied-volatility-index")
            if ivx is not None:
                ivx_by_ticker[item["symbol"]] = float(ivx)
            rating = item.get("liquidity-rating")
            if rating is not None and rating >= MIN_LIQUIDITY_RATING:
                kept.add(item["symbol"])
            else:
                print(
                    f"  {item['symbol']}: liquidity-rating {rating} < {MIN_LIQUIDITY_RATING}, skipping",
                    file=sys.stderr,
                )
    return kept, ivr_by_ticker, ivx_by_ticker


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


def _build_candidate(
    ticker, underlying_mid, underlying_ranges, prev_closes, ivr_by_ticker, ivx_by_ticker
):
    """Fetch one ticker's chain and pick its put. Returns (candidate or None, messages);
    messages are returned rather than printed so concurrent workers don't interleave
    their stderr output."""
    msgs = [f"Fetching option chain for {ticker}..."]
    try:
        resp = get(f"/option-chains/{ticker}/nested")
    except requests.HTTPError:
        msgs.append(f"  {ticker}: option chain fetch failed, skipping")
        return None, msgs
    items = resp["data"]["items"]
    if not items or not items[0]["expirations"]:
        msgs.append(f"  {ticker}: no expirations found, skipping")
        return None, msgs
    expirations = items[0]["expirations"]
    if not any(e["expiration-type"] == "Weekly" for e in expirations):
        msgs.append(f"  {ticker}: no weekly options, skipping")
        return None, msgs
    expiration = pick_expiration(expirations)
    strike = pick_put_strike(expiration, underlying_mid)
    if strike is None:
        msgs.append(f"  {ticker}: no OTM put strike found, skipping")
        return None, msgs
    strike_price = float(strike["strike-price"])
    year_range = underlying_ranges.get(ticker)
    strike_52wk_position = (
        strike_position_in_52wk_range(strike_price, year_range) if year_range else None
    )
    candidate = {
        "ticker": ticker,
        "ivr": ivr_by_ticker.get(ticker),
        "ivx": ivx_by_ticker.get(ticker),
        "expiration": expiration["expiration-date"],
        "dte": expiration["days-to-expiration"],
        "strike": strike_price,
        "put_symbol": strike["put"],
        "strike_52wk_position": strike_52wk_position,
        "chg": change_from_prev_close(underlying_mid, prev_closes.get(ticker)),
    }
    return candidate, msgs


def find_candidates(
    tickers, underlying_mids, underlying_ranges, prev_closes, ivr_by_ticker, ivx_by_ticker
):
    quoted = []
    for ticker in sorted(tickers):
        if underlying_mids.get(ticker) is None:
            print(f"  {ticker}: no underlying quote, skipping", file=sys.stderr)
            continue
        quoted.append(ticker)

    candidates = []
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        # map() yields in submission order, so stderr and the candidate list stay
        # in the same ticker order the serial version produced.
        results = pool.map(
            lambda t: _build_candidate(
                t,
                underlying_mids[t],
                underlying_ranges,
                prev_closes,
                ivr_by_ticker,
                ivx_by_ticker,
            ),
            quoted,
        )
        for candidate, msgs in results:
            for msg in msgs:
                print(msg, file=sys.stderr)
            if candidate is not None:
                candidates.append(candidate)
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


def extract_marginal_buying_power(resp, msgs, ticker=None, debug=False):
    bpe = resp.get("data", {}).get("buying-power-effect", {})
    errors = resp.get("error", {}).get("errors", [])

    if debug:
        msgs.append(f"  [debug] {ticker} dry-run buying-power-effect: {json.dumps(bpe)}")
        if errors:
            msgs.append(f"  [debug] {ticker} dry-run errors: {json.dumps(errors)}")

    hard_errors = [e for e in errors if e.get("code") != "margin_check_failed"]
    if hard_errors and not bpe:
        msgs.append(f"  {ticker}: preflight error: {hard_errors}")
        return None

    for key in ("isolated-order-margin-requirement", "change-in-buying-power", "change-in-margin-requirement"):
        if key in bpe:
            return abs(float(bpe[key]))
    return None


def evaluate_candidate(account_number, candidate, credit_mid, debug=False):
    """Dry-run one candidate's order and build its output row. Returns (row or None,
    messages); like _build_candidate, messages are returned rather than printed."""
    ticker = candidate["ticker"]
    msgs = [f"Dry-running {ticker} {candidate['put_symbol']}..."]
    try:
        resp = dry_run_order(account_number, candidate["put_symbol"], credit_mid)
    except requests.HTTPError:
        msgs.append(f"  {ticker}: dry-run failed, skipping")
        return None, msgs
    marginal_bp = extract_marginal_buying_power(resp, msgs, ticker=ticker, debug=debug)
    if marginal_bp is None:
        msgs.append(f"  {ticker}: could not extract margin requirement, skipping")
        return None, msgs
    if marginal_bp <= 0:
        msgs.append(
            f"  {ticker}: dry-run shows $0 incremental margin requirement "
            f"(account has ample buying-power cushion), skipping from ranking"
        )
        return None, msgs
    credit = credit_mid * 100
    notional = candidate["strike"] * 100
    row = {
        "ticker": ticker,
        "ivr": f"{candidate['ivr'] * 100:.1f}" if candidate["ivr"] is not None else "",
        "ivx": f"{candidate['ivx'] * 100:.1f}" if candidate["ivx"] is not None else "",
        "expiration": candidate["expiration"],
        "dte": candidate["dte"],
        "strike": candidate["strike"],
        "strike 52wk pct": (
            f"{candidate['strike_52wk_position'] * 100:.1f}"
            if candidate["strike_52wk_position"] is not None
            else ""
        ),
        "chg%": f"{candidate['chg'] * 100:.2f}" if candidate["chg"] is not None else "",
        "credit": f"{credit:.1f}",
        "buying_power": f"{marginal_bp:.1f}",
        "credit to bpr": f"{credit / marginal_bp * 100:.1f}",
        "bpr to notional": f"{marginal_bp / notional * 100:.1f}",
        "credit to notional": f"{credit / notional * 100:.1f}",
    }
    return row, msgs


FIELDNAMES = [
    "ticker",
    "expiration",
    "dte",
    "strike",
    "strike 52wk pct",
    "chg%",
    "credit",
    "buying_power",
    "credit to bpr",
    "bpr to notional",
    "credit to notional",
    "ivr",
    "ivx",
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

    tickers, ivr_by_ticker, ivx_by_ticker = filter_by_liquidity(tickers)
    print(f"{len(tickers)} tickers remain after liquidity filter: {sorted(tickers)}", file=sys.stderr)

    underlying_mids, underlying_ranges, prev_closes = fetch_equity_mids(tickers)
    candidates = find_candidates(
        tickers, underlying_mids, underlying_ranges, prev_closes, ivr_by_ticker, ivx_by_ticker
    )

    option_mids = fetch_option_mids([c["put_symbol"] for c in candidates])

    debug = "--debug" in sys.argv
    pending = []
    for c in candidates:
        credit_mid = option_mids.get(c["put_symbol"])
        if credit_mid is None:
            print(f"  {c['ticker']}: no option quote, skipping", file=sys.stderr)
            continue
        pending.append((c, credit_mid))

    rows = []
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        results = pool.map(
            lambda item: evaluate_candidate(account_number, item[0], item[1], debug),
            pending,
        )
        for row, msgs in results:
            for msg in msgs:
                print(msg, file=sys.stderr)
            if row is not None:
                rows.append(row)

    rows.sort(key=lambda r: float(r["credit to bpr"]), reverse=True)

    if "--html" in sys.argv:
        write_html(rows)
    else:
        write_csv(rows)
