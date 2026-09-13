# The `skew` column: design notes

Record of how the 25-delta skew column in `scan-put-bp.py` was built, and why it
ended up different from the original plan in three places. Shipped in commit
`030a177`. The user-facing description lives in README.md; this file is the
reasoning behind it.

## What it measures

```
skew = (IV_call25Δ − IV_put25Δ) / (IV_call25Δ + IV_put25Δ)
```

Both legs come from the same expiration the row's strike comes from, the
monthly nearest 45 DTE. The output is that ratio times 100, so it runs from
−100 (extreme put skew) to +100 (extreme call skew), with 0 meaning calls and
puts at 25 delta price the same volatility.

It describes the *shape* of the smile where `ivr` and `ivx` describe its height,
and because the ratio is normalised by the volatility level it compares across
tickers of very different `ivx`.

## The constraint that shaped everything

The tastytrade REST API exposes no per-strike implied volatility or delta.
`/market-data/by-type` returns prices only. `/market-metrics` returns implied
volatility per *expiration*, never per strike. The broker's own greeks are
available only over the DXLink websocket, which is out of scope for a REST-only
script.

So both implied volatility and delta are computed locally from option mid
prices. scipy was added for `brentq` and `scipy.stats.norm`.

## How it works

1. **Risk-free rate** comes from `/margin-requirements-public-configuration`,
   which needs no authentication, with a constant fallback.
2. **Strike selection** happens in `_build_candidate`, where the chain is
   already in hand, so it costs no request. The expiration's own
   `implied-volatility` from `/market-metrics` seeds a delta estimate, and the
   eight strikes per side closest to 25 delta are recorded.
3. **Quotes** for those strikes ride along in the existing batched option-quote
   pass, which is now parallel.
4. **Inversion** solves each strike's implied volatility with `brentq`, subject
   to the guards below.
5. **Interpolation** to exactly 25 delta happens in `d1` space, not delta.

### Why `d1` and not delta

For calls `|delta| = e^{-qT}·Φ(d1)` and for puts `|delta| = e^{-qT}·Φ(−d1)`, so
setting `x = d1` for calls and `x = −d1` for puts gives both sides one shared
target, `x* = norm.ppf(0.25·e^{qT})`. That is a monotone reparametrization, so
it lands on exactly the same 25-delta point, but `d1` is near-linear in
log-moneyness, which makes the smile close to a straight line across the
window. Delta is steeply nonlinear in the wings, and delta is itself a function
of the volatility just solved, so interpolating against it would put quote noise
on both axes.

### Guards

Before inverting, a strike is dropped when the quote is not two-sided, is
crossed, is cheaper than ten cents, is wider than the spread cap, or sits at or
below discounted intrinsic. After inverting, it is dropped when the solution
lands on a bracket end, falls outside a sane volatility band, or has vega below
one cent per vol point. That last one is the most useful: it is a direct
statement that implied volatility is not identifiable at that strike, and it
retires deep-out-of-the-money noise without guessing a moneyness cutoff.

A strike whose 25-delta point cannot be resolved gets a blank cell and a stderr
line naming the cause, never a guess.

## Three things that changed from the plan

### Dividends are ignored

The plan approximated the dividend stream as a continuous yield from
`dividend-amount` and `dividend-frequency`. That is standard practice and it is
correct in expectation for the *stream*, so it looked safe.

Measured on production quotes it was not. The shift it produced tracked the
annual yield almost one for one: a 6.2%-yield pharmaceutical name moved 6.5
points, a 4.3%-yield telecom moved 4.3 points, and the top of the call-skew
ranking filled up with the highest-yielding names in the watchlist. That is not
a real effect.

The mechanism is that skew is extremely sensitive to the assumed forward. A
forward shift moves `d1` for calls and for puts in opposite directions along the
smile, so the two read points separate by twice the shift, and a fraction of a
percent of spot becomes several points of skew.

The reason the approximation fails is that the API gives an amount and a
frequency but no ex-dates. Annualizing a quarterly payment across a 38-day
window assumes a dividend that most windows do not contain. The pharmaceutical
name pays in February, May, August and November, so an October expiration
contains none of them, and the adjustment was pure error.

Deriving the forward from put-call parity at the at-the-money strike was tried
as the principled fix. Off-hours it produced nonsense, including a −6.6% implied
yield on a fund that pays no dividend, because parity on unsynchronized closing
marks is unreliable. During market hours it would likely work and is the obvious
next improvement, but shipping it unvalidated would have been worse than
shipping the simple version.

So `DIVIDEND_YIELD = 0.0` and the forward is approximated by spot. The residual
error is bounded by one actual dividend, and it is common-mode across the
watchlist rather than proportional to yield.

### The spread cap is 50%, not 30%

Option quotes go wide after the close, and this scan is often run then.
Tightening the cap to 30% dropped coverage from 132 of 150 tickers to 113 while
leaving the median skew of the names that survived both settings unchanged.
Loosening past 50% bought almost nothing.

### The strike window is wider

The plan used a delta window of 0.10 to 0.45 with six strikes per side. That
window is in *seed* delta, and the seed is an at-the-money volatility. On the
call side of an equity smile the true volatility runs below the seed, so the
true deltas come in lower than the seed predicts, and SPY ended up with no
usable strike anywhere near 25 delta. The window is now 0.08 to 0.60 with eight
per side.

## Supporting changes

- `filter_by_liquidity` and `fetch_equity_mids` return one dict per ticker
  instead of loose tuples, so `_build_candidate` stops gaining a parameter per
  column.
- `fetch_option_mids` became `fetch_option_quotes`, returning raw items so the
  skew path can demand a two-sided mid while the credit path still tolerates a
  `last` fallback. Its chunk loop is parallel, which absorbs roughly 2,400 extra
  symbols at no cost in wall clock.
- Spot is re-fetched alongside the option quotes. The original fetch happens
  before about 150 chain requests, and a stale spot moves call and put implied
  volatility in opposite directions, landing straight on this metric.

## Verification

Against production, after hours:

- Index and sector funds show clear put skew: SPY −19.1, IWM −14.3, QQQ −12.9,
  XLK −11.8.
- Precious metals proxies show call skew: silver +6.1, gold +5.8.
- At-the-money strikes invert to within one to three vol points of the API's own
  implied volatility for the same expiration, and the call and put sides agree
  with each other to about one point.
- 132 of 150 tickers populate. Of the 26 individual side failures, 9 had no
  usable strike at all, which is an after-hours artifact rather than a property
  of the metric.
- Runtime is unchanged at roughly 35 seconds.
- The synthetic check: against a manufactured put-skewed smile with nickel-
  rounded prices, the implementation recovers the seeded 25-delta volatilities
  to within 0.2 vol points on both sides.

## Known limitations

- **European model, American options.** Out-of-the-money calls are unaffected,
  since early exercise is never optimal absent a dividend. Out-of-the-money puts
  carry an early-exercise premium that Black-Scholes attributes to volatility,
  overstating put implied volatility by a few tenths of a vol point and biasing
  skew slightly negative. Common-mode, so it does not reorder the ranking.
- **Mid prices, not executable prices.** A wide market's mid is a guess, which
  is what the spread cap is defending against.
- **Mobile carries its own numerics.** `mobile/lib/skew.ts` ports this column and
  `mobile/lib/blackscholes.ts` replaces scipy with a Hart normal CDF, an Acklam
  quantile refined by a Halley step, and a port of `brentq`. Verified against
  scipy on synthetic smiles (vol solves agree to 2e-12) and against a full
  production run, where all 151 rows' `skew` matched to the printed decimal. Both
  sides now have to change together.

## Possible next steps

- Derive the forward from put-call parity during market hours, falling back to
  spot when the parity quotes are stale or the implied yield is implausible.
  This is the single largest remaining error source.
- Re-seed the strike window from the median solved volatility and quote a second
  time when the first window misses. Worth doing only if the blank rate stays
  high during market hours.
- Measure the blank rate mid-session before tuning any guard further. Every
  threshold here was calibrated against closing quotes.
