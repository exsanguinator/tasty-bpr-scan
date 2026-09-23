# tasty-bpr-scan

Ranks short-put candidates from your tastytrade watchlists by credit-to-buying-power
efficiency. `scan-put-bp.py` is the command-line scanner; `mobile/` is a standalone
Android app that runs the same scan on a phone.

Split out of `tasty-sandbox`, with the scanner's git history intact.

## Setup

1. **Create an OAuth application** on [my.tastytrade.com](https://my.tastytrade.com)
   - Manage tab > My Profile > API > OAuth Applications > + New OAuth client
   - Save your `Client Secret` — shown only once
   - On the same page, click `"..."` > Create Grant with the `read` and `trade` scopes,
     and save the `Refresh Token` — this never expires

   The scan dry-runs orders, which needs the `trade` scope. Existing refresh tokens aren't
   upgraded retroactively, so regenerate the grant after adding the scope.

2. **Create a virtual environment and install dependencies**
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install requests python-dotenv scipy
   ```

3. **Configure credentials and the scan**
   ```bash
   cp .env.example .env
   # edit .env with your client secret and refresh token (and Netlify token, to publish)
   cp margin-scan-config.json.example margin-scan-config.json
   # edit margin-scan-config.json with your account number and watchlist names
   ```
   `.env` and `margin-scan-config.json` are gitignored; only the `.example` files are
   checked in. `TASTY_ENV` must be `prod`: the scan depends on `/market-data/by-type`,
   which the `cert` sandbox does not serve.

## Running scan-put-bp.py

```bash
TASTY_ENV=prod python scan-put-bp.py [config-path] [--csv|--html] [--bpr-isolated|--bpr-impact] [--debug]
```

Reads `account_number` and `watchlists` from `margin-scan-config.json` (or the
config path given as the first argument), resolves the equity tickers across
those watchlists, filters out `.IVR` symbols, symbols with `liquidity-rating < 2`,
and symbols without weekly options, then for each remaining ticker picks the
nearest-to-45-DTE monthly expiration's nearest OTM put strike, dry-runs a
1-lot sell-to-open order via `POST /accounts/{account_number}/orders/dry-run`,
and writes the results ranked by `cr/bpr` (see column definitions below).
Output is CSV to stdout by default, or `--csv` explicitly; pass `--html` to
instead write a standalone HTML page with a click-to-sort results table, followed by
the date and time the page was generated and an `Export to CSV` button that
downloads the table in its current sort order. Pass
`--debug` to print each ticker's raw `buying-power-effect` and any preflight
errors to stderr. Pass `-h`/`--help` for a summary of all arguments and their
defaults; it works without `TASTY_ENV=prod` and makes no API calls. Unknown or
conflicting arguments (e.g. `--csv --html`) exit with an error before the scan
starts.

Which dry-run figure becomes the `bpr` column is chosen with one of:
- `--bpr-isolated` (default) — `isolated-order-margin-requirement`: the margin
  this order requires on its own, regardless of the account's existing
  positions. The premium received doesn't reduce it, so `cr/bpr`
  compares premium against margin.
- `--bpr-impact` — `change-in-buying-power`: how much the account's buying
  power actually drops (`current-buying-power − new-buying-power`). This
  reflects existing positions and is roughly
  `margin change − credit received + fees`. Because the credit is already
  subtracted in the denominator, `cr/bpr` comes out higher than in
  isolated mode, most of all for high-premium names. When a ticker's
  credit covers its whole margin change, buying power doesn't drop, so
  `bpr` is `<= 0` (see `bpr` below).

Passing both flags is an error.

**Column definitions:** `52wk%`, `credit`, `bpr`,
`cr/bpr`, `bpr/ntl`, `cr/ntl`, `ivr`, `ivx`, and
`skew` are all formatted as zero-padded numbers with 1 decimal place (e.g.
`"1.0"`, not `"1"`); `chg%` uses 2 decimal places (e.g. `"-1.25"`).
- `52wk%` — where the strike sits in the underlying's 52-week range,
  as a percentage: `(strike - 52wk_low) / (52wk_high - 52wk_low) * 100`.
  `0` = strike at the 52-week low, `100` = at the 52-week high. Can fall
  slightly outside `[0, 100]` if the strike is beyond the current 52-week
  range.
- `chg%` — how far the underlying's current mid has moved from the previous
  day's close, as a percentage: `(underlying_mid - prev_close) / prev_close
  * 100`, using `prev-close` from `/market-data/by-type`. Negative when the
  underlying is down on the day.
- `credit` — estimated premium received for selling 1 contract, in dollars
  (`option mid price * 100`).
- `bpr` — the buying power this 1-lot order consumes, from the
  order dry-run: `isolated-order-margin-requirement` by default, or
  `change-in-buying-power` with `--bpr-impact` (see above). Every ticker
  appears in the output, even when its buying power can't be ranked:
  - If the dry-run fails or lacks that field, `bpr`,
    `cr/bpr`, and `bpr/ntl` are all blank.
  - If the amount is `<= 0`, `bpr` shows it (colored red in the
    HTML table) and `cr/bpr` and `bpr/ntl` are blank. That
    includes orders the dry-run marks as freeing buying power
    (`-effect: Credit`), which show as negative.

  Both kinds of row sort after the ranked rows in CSV output, in ticker
  order.
- `cr/bpr` — `credit / bpr * 100`, as a percentage.
  **Capital efficiency under this account's margin rules**: how much
  premium you collect per dollar of buying power the trade actually
  consumes. The primary ranking column, since the whole point of this
  script is to find trades that use your account's margin (a scarce
  resource) efficiently — it is account- and margin-type-specific (Reg T
  vs. Portfolio Margin accounts will show very different numbers for the
  same trade).
- `bpr/ntl` — `bpr / (strike * 100) * 100`, as a
  percentage. What fraction of the trade's full notional (100 shares at
  the strike) your margin system is actually holding you to. Low values
  mean the account's margin treatment is very capital-efficient for that
  position (portfolio margin, existing offsetting positions, etc.); a
  value near `100` means you're being held to roughly cash-secured-put
  levels.
- `cr/ntl` — `credit / (strike * 100) * 100`, as a percentage.
  A **reward** (yield) metric, not a risk or margin metric — the classic
  "cash-secured put yield": premium collected as a percentage of the
  capital you'd need if assigned. It's account- and margin-agnostic, so
  it's useful for comparing tickers on an apples-to-apples basis, but note
  it's an imperfect, indirect proxy for risk too: since premium scales
  with implied volatility, a high `cr/ntl` often means the
  market is pricing in more risk for that name, not that you're being
  overpaid for the risk taken (i.e. it is not a measure of edge).
- `ivr` — IV Rank (`implied-volatility-index-rank` from `/market-metrics`),
  as a percentage. Where the ticker's current implied volatility sits
  within its 1-year IV range.
- `ivx` — 30-day implied volatility (`implied-volatility-index` from
  `/market-metrics`), as a percentage.
- `skew` — 25-delta volatility skew for the same expiration the row's
  strike comes from: `(IV_25d_call - IV_25d_put) / (IV_25d_call +
  IV_25d_put) * 100`, so it runs from `-100` (extreme put skew) to `+100`
  (extreme call skew), and `0` means calls and puts at 25 delta price the
  same volatility. Negative is the usual reading for index and large-cap
  names: the market is paying up for downside protection, which is what you
  are selling. Positive is less common and tends to show up in commodity
  proxies and names with squeeze or takeover dynamics. Because the ratio is
  normalised by the level of volatility, it is comparable across tickers of
  very different `ivx`, and unlike `ivr` and `ivx` it describes the *shape*
  of the smile rather than its height.

  The API exposes no per-strike implied volatility or delta, so this is
  computed locally. Strikes on each side are seeded from that expiration's
  `implied-volatility` (`/market-metrics`), quoted through
  `/market-data/by-type`, inverted to an implied volatility with a
  Black-Scholes root find, and interpolated to exactly 25 delta. The
  interpolation works in `d1` rather than in delta directly, since implied
  volatility is close to linear in `d1` across the window but steeply
  nonlinear against delta out in the wings. The risk-free rate comes from
  `/margin-requirements-public-configuration`.

  Three caveats. The model is European while US equity options are
  American: out-of-the-money calls are unaffected, since early exercise is
  never optimal without a dividend, but out-of-the-money puts carry an
  early-exercise premium that Black-Scholes attributes to volatility,
  overstating put implied volatility by a few tenths of a vol point and
  biasing `skew` slightly negative. Dividends are ignored entirely and the
  forward is approximated by spot, because the API gives a dividend amount
  and frequency but no ex-dates, and annualizing a quarterly payment across
  a 45-day window assumes a dividend most windows do not contain; measured
  on production quotes, doing so moved `skew` by up to 6.5 points on a
  6%-yield name and pushed the highest-yielding names to the top of the
  call-skew ranking, which is not a real effect. Finally the inputs are mid
  prices, so a name whose 25-delta strikes are quoted too wide, too thin or
  too far from 25 delta is left blank rather than guessed at, with the
  reason on stderr. Treat `skew` as a comparative screening number across
  tickers, not as an absolute value or a substitute for a broker greek.

## Publishing to Netlify

`publish-netlify.py` deploys HTML files to a Netlify site through the Netlify API:

```bash
python publish-netlify.py scan.html                  # → https://<site>/scan.html
python publish-netlify.py scan.html --as index.html  # publish as the site's home page
python publish-netlify.py scan-*.html                # several files in one deploy
python publish-netlify.py scan.html --replace        # drop everything else on the site
```

It needs a personal access token (Netlify > User settings > Applications > Personal
access tokens) in `.env` as `NETLIFY_AUTH_TOKEN`. The target site defaults to
`cosmic-palmier-7dd8d7.netlify.app`; override it with `--site` or `NETLIFY_SITE_ID`.
Netlify deploys are full snapshots, so the script starts from the site's current file
list and pages published earlier stay up unless `--replace` is given. It prints each
published URL once the deploy is live.

`sh-regt.sh` runs the whole pipeline: it scans the watchlists in
`margin-scan-config-regt.json` (create it from `margin-scan-config.json.example`, like
the default config) with `--html --bpr-isolated`, and publishes the result as the
site's `index.html`. The scan is written to a temp file and moved into place only on
success, so a failed scan stops the script without replacing the live page. It can be
run from any directory, e.g. from cron.

## Notes

- Access tokens expire after 15 minutes and are refreshed automatically
- Market data (`/market-data/by-type`) is only available in `prod`

## Android app

`mobile/` holds a standalone Expo / React Native port of `scan-put-bp.py` that runs the
same scan on an Android phone with no backend: a Settings screen for picking the account,
watchlists and BPR mode, and an on-screen sortable results table. Credentials are baked
into the build from this repo's `.env`. See [mobile/README.md](mobile/README.md) for the
build and sideload instructions.

## Screenshot

Sample HTML output screenshot of a REG-T margin account.

<img width="1109" height="567" alt="image" src="https://github.com/user-attachments/assets/d6f846ab-2245-423d-86f7-25d0a6619d92" />
