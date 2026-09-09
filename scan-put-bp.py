import csv
import json
import math
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests
from dotenv import find_dotenv, load_dotenv
from scipy.optimize import brentq
from scipy.stats import norm

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


DEFAULT_RISK_FREE_RATE = 0.04


def fetch_risk_free_rate():
    """/margin-requirements-public-configuration needs no auth and the API docs
    endorse its rate as a Black-Scholes input. Falls back to a constant rather
    than failing the scan, since skew barely moves with a few bps of error."""
    try:
        resp = get("/margin-requirements-public-configuration")
        rate = float(resp["data"]["risk-free-rate"])
    except (requests.RequestException, KeyError, TypeError, ValueError) as exc:
        print(
            f"Risk-free rate fetch failed ({exc}); using {DEFAULT_RISK_FREE_RATE}",
            file=sys.stderr,
        )
        return DEFAULT_RISK_FREE_RATE
    print(f"Risk-free rate: {rate}", file=sys.stderr)
    return rate


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
    """Returns (mids, underlying_by_ticker). The per-ticker dict carries everything
    downstream needs about the underlying, so adding a field here doesn't mean
    adding another positional argument to every function in the call chain."""
    mids = {}
    underlying = {}
    for chunk in chunked(sorted(tickers), 100):
        resp = get("/market-data/by-type", equity=",".join(chunk))
        for item in resp["data"]["items"]:
            symbol = item["symbol"]
            mids[symbol] = _mid(item)
            year_low = item.get("year-low-price")
            year_high = item.get("year-high-price")
            prev_close = item.get("prev-close")
            underlying[symbol] = {
                "year_range": (
                    (float(year_low), float(year_high))
                    if year_low is not None and year_high is not None
                    else None
                ),
                "prev_close": float(prev_close) if prev_close is not None else None,
            }
    return mids, underlying


def _float_or_none(value):
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# Dividends are ignored: the forward is approximated by spot. /market-data/by-type
# gives a dividend amount and frequency but no ex-dates, and annualizing a
# quarterly payment across a ~45-day window assumes a dividend that most windows
# do not contain. Measured on production quotes, doing so moved skew by up to 6.5
# points on a 6%-yield name - larger than the spread of the metric itself - and
# pushed the highest-yielding names to the top of the call-skew ranking, which is
# not a real effect. See the `skew` notes in README.md.
DIVIDEND_YIELD = 0.0


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


def fetch_option_quotes(symbols):
    """Returns the raw quote item per symbol, so callers can pick their own mid:
    the credit path tolerates a `last` fallback, the skew path does not.

    The chunk loop is parallel because skew multiplies the symbol count by an
    order of magnitude, and serially those chunks would be the only unparallelized
    phase left in the scan."""
    chunks = list(chunked(sorted(set(symbols)), 100))
    if not chunks:
        return {}

    def fetch(chunk):
        resp = get("/market-data/by-type", **{"equity-option": ",".join(chunk)})
        return resp["data"]["items"]

    quotes = {}
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        for items in pool.map(fetch, chunks):
            for item in items:
                quotes[item["symbol"]] = item
    return quotes


MIN_LIQUIDITY_RATING = 2


def filter_by_liquidity(tickers):
    """Returns (kept, metrics_by_ticker). Each metrics entry holds ivr, ivx and
    exp_ivs, the per-expiration implied volatilities that seed the skew strike
    search."""
    kept = set()
    metrics = {}
    for chunk in chunked(sorted(tickers), 100):
        resp = get("/market-metrics", symbols=",".join(chunk))
        for item in resp["data"]["items"]:
            symbol = item["symbol"]
            metrics[symbol] = {
                "ivr": _float_or_none(item.get("implied-volatility-index-rank")),
                "ivx": _float_or_none(item.get("implied-volatility-index")),
                "exp_ivs": _expiration_ivs(item),
            }
            rating = item.get("liquidity-rating")
            if rating is not None and rating >= MIN_LIQUIDITY_RATING:
                kept.add(symbol)
            else:
                print(
                    f"  {symbol}: liquidity-rating {rating} < {MIN_LIQUIDITY_RATING}, skipping",
                    file=sys.stderr,
                )
    return kept, metrics


def _expiration_ivs(item):
    """Keyed by YYYY-MM-DD: market-metrics can return a full timestamp where the
    option chain returns a plain date, so both sides are truncated to match."""
    ivs = {}
    for entry in item.get("option-expiration-implied-volatilities") or []:
        date = entry.get("expiration-date")
        iv = _float_or_none(entry.get("implied-volatility"))
        if date and iv:
            ivs[date[:10]] = iv
    return ivs


def _mid(item):
    bid = item.get("bid")
    ask = item.get("ask")
    if bid is not None and ask is not None:
        return (float(bid) + float(ask)) / 2
    last = item.get("last")
    return float(last) if last is not None else None


def _two_sided_mid(item):
    """Stricter than _mid: no `last` fallback. A stale last print on an illiquid
    wing strike inverts to a plausible-looking but meaningless implied vol, and
    nothing downstream can tell that apart from a real quote."""
    bid = _float_or_none(item.get("bid"))
    ask = _float_or_none(item.get("ask"))
    if bid is None or ask is None or bid <= 0 or ask <= bid:
        return None
    return (bid + ask) / 2, bid, ask


# Black-Scholes with a continuous dividend yield. European, while US equity
# options are American - see the `skew` column notes in README.md for the size
# and direction of the resulting bias.
SIGMA_BRACKET = (0.01, 3.0)
MIN_SIGMA = 0.03
MAX_SIGMA = 3.0
MIN_VEGA = 1.0
MIN_OPTION_MID = 0.10
# Widest quote accepted, as the larger of an absolute and a relative bound. The
# absolute floor matters on its own: a nickel-wide market on a $0.15 option is 33%
# wide but perfectly ordinary.
# 0.50 rather than something tighter because option quotes go wide after the
# close, and the scan is often run then. Measured against production closing
# quotes, tightening to 0.30 dropped coverage from 132 of 150 tickers to 113 while
# leaving the median skew of the names that survived both settings unchanged.
MAX_SPREAD_ABSOLUTE = 0.10
MAX_SPREAD_RELATIVE = 0.50


def bs_d1(s, k, t, r, q, sigma):
    return (math.log(s / k) + (r - q + sigma * sigma / 2) * t) / (sigma * math.sqrt(t))


def bs_price(is_call, s, k, t, r, q, sigma):
    d1 = bs_d1(s, k, t, r, q, sigma)
    d2 = d1 - sigma * math.sqrt(t)
    if is_call:
        return s * math.exp(-q * t) * norm.cdf(d1) - k * math.exp(-r * t) * norm.cdf(d2)
    return k * math.exp(-r * t) * norm.cdf(-d2) - s * math.exp(-q * t) * norm.cdf(-d1)


def bs_delta(is_call, s, k, t, r, q, sigma):
    d1 = bs_d1(s, k, t, r, q, sigma)
    return math.exp(-q * t) * (norm.cdf(d1) if is_call else norm.cdf(d1) - 1)


def bs_vega(s, k, t, r, q, sigma):
    """Per 1.00 of vol, and per contract: 100 shares, so a vega of 1.0 is a cent
    of option price per vol point."""
    d1 = bs_d1(s, k, t, r, q, sigma)
    return s * math.exp(-q * t) * norm.pdf(d1) * math.sqrt(t) * 100


def european_lower_bound(is_call, s, k, t, r, q):
    forward = s * math.exp(-q * t)
    discounted_strike = k * math.exp(-r * t)
    return max(0.0, forward - discounted_strike if is_call else discounted_strike - forward)


def implied_vol(is_call, price, s, k, t, r, q):
    """Returns None rather than clamping when the price falls outside the sigma
    bracket: a solution pinned to an endpoint is not a solution, and it would
    distort the interpolation far more than a missing point does."""
    lo, hi = SIGMA_BRACKET
    try:
        sigma = brentq(
            lambda sig: bs_price(is_call, s, k, t, r, q, sig) - price, lo, hi, xtol=1e-6
        )
    except (ValueError, RuntimeError):
        return None
    if sigma <= lo + 1e-4 or sigma >= hi - 1e-4:
        return None
    if not MIN_SIGMA <= sigma <= MAX_SIGMA:
        return None
    if bs_vega(s, k, t, r, q, sigma) < MIN_VEGA:
        return None
    return sigma


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


TARGET_SKEW_DELTA = 0.25
SKEW_STRIKES_PER_SIDE = 8
# Wide, and in *seed* delta rather than true delta. The seed is an at-the-money
# vol, so on the call side of an equity smile the true vol runs below it and the
# true deltas come in lower than the seed suggests - a narrower window left names
# like SPY with no strike anywhere near 25 delta.
SKEW_DELTA_WINDOW = (0.08, 0.60)
# Equity smiles put the true put vol above the seed and the call vol below it, so
# each side's window is centred with a seed nudged the way the smile leans.
SKEW_SEED_BIAS = {"call": 0.90, "put": 1.15}
# Widest gap in d1 the interpolation will span, and how far past the outermost
# point it will extrapolate. Beyond either, the chain is too sparse to say
# anything about the 25-delta vol.
MAX_INTERP_WIDTH = 0.60
MAX_EXTRAP_DISTANCE = 0.15


def select_skew_strikes(strikes, spot, t, r, q, sigma_seed, per_side=SKEW_STRIKES_PER_SIDE):
    """Picks the strikes to quote for each side of the skew. Returns
    (call_entries, put_entries) as (strike_price, occ_symbol) pairs, or empty
    lists when the chain is too sparse around 25 delta to interpolate."""
    low, high = SKEW_DELTA_WINDOW
    sides = {}
    for side, is_call in (("call", True), ("put", False)):
        sigma = sigma_seed * SKEW_SEED_BIAS[side]
        scored = []
        for entry in strikes:
            strike = _float_or_none(entry.get("strike-price"))
            symbol = entry.get(side)
            if strike is None or strike <= 0 or not symbol:
                continue
            delta = abs(bs_delta(is_call, spot, strike, t, r, q, sigma))
            if low <= delta <= high:
                scored.append((abs(delta - TARGET_SKEW_DELTA), strike, symbol))
        scored.sort()
        kept = [(strike, symbol) for _, strike, symbol in scored[:per_side]]
        sides[side] = kept if len(kept) >= 2 else []
    return sides["call"], sides["put"]


def _solve_side(is_call, entries, quotes, s, t, r, q):
    """Inverts each quoted strike to an implied vol. Returns [(x, iv)] where x is
    d1 for calls and -d1 for puts, so both sides share one target coordinate."""
    points = []
    for strike, symbol in entries:
        item = quotes.get(symbol)
        if item is None:
            continue
        two_sided = _two_sided_mid(item)
        if two_sided is None:
            continue
        mid, bid, ask = two_sided
        if mid < MIN_OPTION_MID:
            continue
        if (ask - bid) > max(MAX_SPREAD_ABSOLUTE, MAX_SPREAD_RELATIVE * mid):
            continue
        if mid <= european_lower_bound(is_call, s, strike, t, r, q) + 0.01:
            continue
        sigma = implied_vol(is_call, mid, s, strike, t, r, q)
        if sigma is None:
            continue
        d1 = bs_d1(s, strike, t, r, q, sigma)
        points.append((d1 if is_call else -d1, sigma))
    points.sort()
    return points


def interpolate_iv_at_delta(points, q, t, target_delta=TARGET_SKEW_DELTA):
    """Interpolates implied vol at the target delta, working in d1 rather than in
    delta directly. d1 is near-linear in log-moneyness so the smile is close to a
    straight line across the window, while delta is steeply nonlinear in the
    wings and is itself a function of the vol just solved."""
    if len(points) < 2:
        return None
    target = norm.ppf(min(target_delta * math.exp(q * t), 1 - 1e-9))
    for (x0, iv0), (x1, iv1) in zip(points, points[1:]):
        if x0 <= target <= x1:
            if x1 - x0 > MAX_INTERP_WIDTH:
                return None
            weight = 0.0 if x1 == x0 else (target - x0) / (x1 - x0)
            return iv0 + weight * (iv1 - iv0)
    # Not bracketed: extrapolate a short way off the nearest end, no further.
    if target < points[0][0]:
        (x0, iv0), (x1, iv1) = points[0], points[1]
        distance = points[0][0] - target
    else:
        (x0, iv0), (x1, iv1) = points[-2], points[-1]
        distance = target - points[-1][0]
    if distance > MAX_EXTRAP_DISTANCE or x1 == x0:
        return None
    return iv0 + (target - x0) / (x1 - x0) * (iv1 - iv0)


def compute_skew(candidate, quotes, spot):
    """(IV_25d_call - IV_25d_put) / (IV_25d_call + IV_25d_put), in [-1, 1].
    Returns (skew or None, messages)."""
    ticker = candidate["ticker"]
    msgs = []
    calls, puts = candidate.get("skew_calls"), candidate.get("skew_puts")
    if not calls or not puts or not spot:
        return None, msgs
    t = candidate["skew_t"]
    r = candidate["risk_free_rate"]
    q = DIVIDEND_YIELD

    ivs = {}
    for side, is_call, entries in (("call", True, calls), ("put", False, puts)):
        points = _solve_side(is_call, entries, quotes, spot, t, r, q)
        iv = interpolate_iv_at_delta(points, q, t)
        if iv is None:
            # |delta| = exp(-qt) * N(x) on both sides, by construction of x.
            deltas = [math.exp(-q * t) * norm.cdf(x) for x, _ in points]
            span = f"{min(deltas):.2f}-{max(deltas):.2f}" if deltas else "none"
            msgs.append(
                f"  {ticker}: no 25-delta {side} vol "
                f"({len(points)} usable strikes, deltas {span}, seed {candidate['skew_seed']:.3f})"
            )
        ivs[side] = iv

    if ivs["call"] is None or ivs["put"] is None:
        return None, msgs
    total = ivs["call"] + ivs["put"]
    if total <= 0:
        return None, msgs
    return (ivs["call"] - ivs["put"]) / total, msgs


def _build_candidate(ticker, underlying_mid, underlying_by_ticker, metrics_by_ticker, rate):
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
    underlying = underlying_by_ticker.get(ticker, {})
    metrics = metrics_by_ticker.get(ticker, {})
    year_range = underlying.get("year_range")
    strike_52wk_position = (
        strike_position_in_52wk_range(strike_price, year_range) if year_range else None
    )
    candidate = {
        "ticker": ticker,
        "ivr": metrics.get("ivr"),
        "ivx": metrics.get("ivx"),
        "expiration": expiration["expiration-date"],
        "dte": expiration["days-to-expiration"],
        "strike": strike_price,
        "put_symbol": strike["put"],
        "strike_52wk_position": strike_52wk_position,
        "chg": change_from_prev_close(underlying_mid, underlying.get("prev_close")),
        "risk_free_rate": rate,
        "skew": None,
    }
    _attach_skew_strikes(candidate, expiration, underlying_mid, metrics, rate, msgs)
    return candidate, msgs


def _attach_skew_strikes(candidate, expiration, spot, metrics, rate, msgs):
    """Chooses which strikes the skew calculation will need quotes for. Runs here
    because the chain is already in hand, so strike selection costs no request;
    only the quotes themselves do."""
    ticker = candidate["ticker"]
    date = str(expiration["expiration-date"])[:10]
    seed = metrics.get("exp_ivs", {}).get(date) or metrics.get("ivx")
    if not seed:
        msgs.append(f"  {ticker}: no seed IV for {date}, skipping skew")
        return
    # Calendar time, matching the ACT/365 convention behind the ivx column.
    t = max(candidate["dte"], 1) / 365.0
    q = DIVIDEND_YIELD
    calls, puts = select_skew_strikes(expiration["strikes"], spot, t, rate, q, seed)
    if not calls or not puts:
        msgs.append(f"  {ticker}: too few strikes near 25 delta, skipping skew")
        return
    candidate["skew_calls"] = calls
    candidate["skew_puts"] = puts
    candidate["skew_t"] = t
    candidate["skew_seed"] = seed


def find_candidates(tickers, underlying_mids, underlying_by_ticker, metrics_by_ticker, rate):
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
                t, underlying_mids[t], underlying_by_ticker, metrics_by_ticker, rate
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
        "skew": f"{candidate['skew'] * 100:.1f}" if candidate.get("skew") is not None else "",
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
    "skew",
]

# Columns rendered green when positive and red when negative; zero stays neutral.
SIGNED_COLUMNS = frozenset({"chg%", "skew"})


def write_csv(rows, out=sys.stdout):
    writer = csv.DictWriter(out, fieldnames=FIELDNAMES)
    writer.writeheader()
    writer.writerows(rows)


def write_html(rows, out=sys.stdout):
    def cell(value):
        return "" if value == "" else str(value)

    def cell_class(name, value):
        """Colour the signed columns by sign; zero and blanks stay neutral."""
        if name not in SIGNED_COLUMNS or value == "":
            return ""
        change = float(value)
        if change > 0:
            return ' class="pos"'
        if change < 0:
            return ' class="neg"'
        return ""

    header_cells = "".join(f"<th onclick=\"sortTable({i})\">{name}</th>" for i, name in enumerate(FIELDNAMES))
    body_rows = "\n".join(
        "<tr>"
        + "".join(f"<td{cell_class(name, row[name])}>{cell(row[name])}</td>" for name in FIELDNAMES)
        + "</tr>"
        for row in rows
    )

    out.write(f"""<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>scan-put-bp results</title>
<style>
  /* Dark palette, matching the mobile app's dark theme (mobile/lib/theme.ts). */
  body {{ font-family: sans-serif; font-size: 14px; background: #121417; color: #e7e9ec; }}
  table {{ border-collapse: collapse; }}
  th, td {{ border: 1px solid #2c3138; padding: 4px 8px; text-align: right; }}
  th:first-child, td:first-child {{ text-align: left; }}
  th {{ cursor: pointer; background: #21262c; user-select: none; }}
  tbody tr:nth-child(even) {{ background: #171a1e; }}
  th.asc::after {{ content: " \\25B2"; }}
  th.desc::after {{ content: " \\25BC"; }}
  td.pos {{ color: #5fd894; }}
  td.neg {{ color: #ff9a90; }}
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

    tickers, metrics_by_ticker = filter_by_liquidity(tickers)
    print(f"{len(tickers)} tickers remain after liquidity filter: {sorted(tickers)}", file=sys.stderr)

    rate = fetch_risk_free_rate()
    underlying_mids, underlying_by_ticker = fetch_equity_mids(tickers)
    candidates = find_candidates(
        tickers, underlying_mids, underlying_by_ticker, metrics_by_ticker, rate
    )

    skew_symbols = [
        symbol
        for c in candidates
        for entries in (c.get("skew_calls") or [], c.get("skew_puts") or [])
        for _, symbol in entries
    ]
    quotes = fetch_option_quotes([c["put_symbol"] for c in candidates] + skew_symbols)

    # The mids fetched above are stale by roughly one full chain-fetch phase, and a
    # wrong spot moves call and put IV in opposite directions, landing straight on
    # the skew. Two requests buys a spot contemporaneous with the option quotes.
    skew_spots, _ = fetch_equity_mids({c["ticker"] for c in candidates})

    debug = "--debug" in sys.argv
    pending = []
    for c in candidates:
        quote = quotes.get(c["put_symbol"])
        credit_mid = _mid(quote) if quote else None
        if credit_mid is None:
            print(f"  {c['ticker']}: no option quote, skipping", file=sys.stderr)
            continue
        spot = skew_spots.get(c["ticker"]) or underlying_mids.get(c["ticker"])
        try:
            c["skew"], skew_msgs = compute_skew(c, quotes, spot)
        except Exception as exc:  # never let one ticker's smile kill the scan
            c["skew"], skew_msgs = None, [f"  {c['ticker']}: skew failed ({exc})"]
        for msg in skew_msgs:
            print(msg, file=sys.stderr)
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
