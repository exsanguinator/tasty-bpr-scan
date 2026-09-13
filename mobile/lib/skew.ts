/**
 * 25-delta volatility skew, ported from the `skew` column in `scan-put-bp.py`:
 *
 *   skew = (IV_25d_call - IV_25d_put) / (IV_25d_call + IV_25d_put)
 *
 * The tastytrade REST API exposes no per-strike implied volatility or delta, so
 * both are solved locally from option mid prices.
 */
import {
  brentq,
  bsD1,
  bsDelta,
  bsPrice,
  bsVega,
  europeanLowerBound,
  normCdf,
  normPpf,
} from "./blackscholes";

/**
 * Dividends are ignored: the forward is approximated by spot. /market-data/by-type
 * gives a dividend amount and frequency but no ex-dates, and annualizing a
 * quarterly payment across a ~45-day window assumes a dividend that most windows
 * do not contain. Measured on production quotes, doing so moved skew by up to 6.5
 * points on a 6%-yield name - larger than the spread of the metric itself - and
 * pushed the highest-yielding names to the top of the call-skew ranking, which is
 * not a real effect. See the `skew` notes in the repo README.
 */
export const DIVIDEND_YIELD = 0;

export const DEFAULT_RISK_FREE_RATE = 0.04;

const SIGMA_BRACKET: [number, number] = [0.01, 3.0];
const MIN_SIGMA = 0.03;
const MAX_SIGMA = 3.0;
const MIN_VEGA = 1.0;
const MIN_OPTION_MID = 0.1;
// Widest quote accepted, as the larger of an absolute and a relative bound. The
// absolute floor matters on its own: a nickel-wide market on a $0.15 option is 33%
// wide but perfectly ordinary.
// 0.50 rather than something tighter because option quotes go wide after the
// close, and the scan is often run then.
const MAX_SPREAD_ABSOLUTE = 0.1;
const MAX_SPREAD_RELATIVE = 0.5;

const TARGET_SKEW_DELTA = 0.25;
const SKEW_STRIKES_PER_SIDE = 8;
// Wide, and in *seed* delta rather than true delta. The seed is an at-the-money
// vol, so on the call side of an equity smile the true vol runs below it and the
// true deltas come in lower than the seed suggests - a narrower window left names
// like SPY with no strike anywhere near 25 delta.
const SKEW_DELTA_WINDOW: [number, number] = [0.08, 0.6];
// Equity smiles put the true put vol above the seed and the call vol below it, so
// each side's window is centred with a seed nudged the way the smile leans.
const SKEW_SEED_BIAS = { call: 0.9, put: 1.15 };
// Widest gap in d1 the interpolation will span, and how far past the outermost
// point it will extrapolate. Beyond either, the chain is too sparse to say
// anything about the 25-delta vol.
const MAX_INTERP_WIDTH = 0.6;
const MAX_EXTRAP_DISTANCE = 0.15;

/** (strike price, OCC symbol) for one strike to be quoted. */
export type SkewStrike = [number, string];

export type SkewQuote = { bid?: string | null; ask?: string | null };

function floatOrNull(value: unknown): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Stricter than the scan's `mid`: no `last` fallback. A stale last print on an
 * illiquid wing strike inverts to a plausible-looking but meaningless implied
 * vol, and nothing downstream can tell that apart from a real quote.
 */
function twoSidedMid(item: SkewQuote): { mid: number; bid: number; ask: number } | null {
  const bid = floatOrNull(item.bid);
  const ask = floatOrNull(item.ask);
  if (bid === null || ask === null || bid <= 0 || ask <= bid) return null;
  return { mid: (bid + ask) / 2, bid, ask };
}

/**
 * Returns null rather than clamping when the price falls outside the sigma
 * bracket: a solution pinned to an endpoint is not a solution, and it would
 * distort the interpolation far more than a missing point does.
 */
function impliedVol(
  isCall: boolean,
  price: number,
  s: number,
  k: number,
  t: number,
  r: number,
  q: number,
): number | null {
  const [lo, hi] = SIGMA_BRACKET;
  const sigma = brentq((sig) => bsPrice(isCall, s, k, t, r, q, sig) - price, lo, hi, 1e-6);
  if (sigma === null) return null;
  if (sigma <= lo + 1e-4 || sigma >= hi - 1e-4) return null;
  if (sigma < MIN_SIGMA || sigma > MAX_SIGMA) return null;
  if (bsVega(s, k, t, r, q, sigma) < MIN_VEGA) return null;
  return sigma;
}

/** One strike entry from an `/option-chains/{ticker}/nested` expiration. */
type ChainStrike = { "strike-price"?: string | null; call?: string | null; put?: string | null };

/**
 * Picks the strikes to quote for each side of the skew. Returns empty lists when
 * the chain is too sparse around 25 delta to interpolate.
 */
export function selectSkewStrikes(
  strikes: ChainStrike[],
  spot: number,
  t: number,
  r: number,
  q: number,
  sigmaSeed: number,
  perSide = SKEW_STRIKES_PER_SIDE,
): { calls: SkewStrike[]; puts: SkewStrike[] } {
  const [low, high] = SKEW_DELTA_WINDOW;
  const sides: Record<"call" | "put", SkewStrike[]> = { call: [], put: [] };
  for (const [side, isCall] of [
    ["call", true],
    ["put", false],
  ] as const) {
    const sigma = sigmaSeed * SKEW_SEED_BIAS[side];
    const scored: { distance: number; strike: number; symbol: string }[] = [];
    for (const entry of strikes) {
      const strike = floatOrNull(entry["strike-price"]);
      const symbol = entry[side];
      if (strike === null || strike <= 0 || !symbol) continue;
      const delta = Math.abs(bsDelta(isCall, spot, strike, t, r, q, sigma));
      if (delta >= low && delta <= high) {
        scored.push({ distance: Math.abs(delta - TARGET_SKEW_DELTA), strike, symbol });
      }
    }
    // Sorted the way Python's tuple sort does: by distance, then strike, then symbol.
    scored.sort(
      (a, b) =>
        a.distance - b.distance || a.strike - b.strike || a.symbol.localeCompare(b.symbol),
    );
    const kept = scored.slice(0, perSide).map(({ strike, symbol }): SkewStrike => [strike, symbol]);
    sides[side] = kept.length >= 2 ? kept : [];
  }
  return { calls: sides.call, puts: sides.put };
}

/**
 * Inverts each quoted strike to an implied vol. Returns [x, iv] pairs where x is
 * d1 for calls and -d1 for puts, so both sides share one target coordinate.
 */
function solveSide(
  isCall: boolean,
  entries: SkewStrike[],
  quotes: Map<string, SkewQuote>,
  s: number,
  t: number,
  r: number,
  q: number,
): [number, number][] {
  const points: [number, number][] = [];
  for (const [strike, symbol] of entries) {
    const item = quotes.get(symbol);
    if (!item) continue;
    const twoSided = twoSidedMid(item);
    if (!twoSided) continue;
    const { mid, bid, ask } = twoSided;
    if (mid < MIN_OPTION_MID) continue;
    if (ask - bid > Math.max(MAX_SPREAD_ABSOLUTE, MAX_SPREAD_RELATIVE * mid)) continue;
    if (mid <= europeanLowerBound(isCall, s, strike, t, r, q) + 0.01) continue;
    const sigma = impliedVol(isCall, mid, s, strike, t, r, q);
    if (sigma === null) continue;
    const d1 = bsD1(s, strike, t, r, q, sigma);
    points.push([isCall ? d1 : -d1, sigma]);
  }
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return points;
}

/**
 * Interpolates implied vol at the target delta, working in d1 rather than in
 * delta directly. d1 is near-linear in log-moneyness so the smile is close to a
 * straight line across the window, while delta is steeply nonlinear in the wings
 * and is itself a function of the vol just solved.
 */
export function interpolateIvAtDelta(
  points: [number, number][],
  q: number,
  t: number,
  targetDelta = TARGET_SKEW_DELTA,
): number | null {
  if (points.length < 2) return null;
  const target = normPpf(Math.min(targetDelta * Math.exp(q * t), 1 - 1e-9));
  for (let i = 0; i + 1 < points.length; i++) {
    const [x0, iv0] = points[i];
    const [x1, iv1] = points[i + 1];
    if (x0 <= target && target <= x1) {
      if (x1 - x0 > MAX_INTERP_WIDTH) return null;
      const weight = x1 === x0 ? 0 : (target - x0) / (x1 - x0);
      return iv0 + weight * (iv1 - iv0);
    }
  }
  // Not bracketed: extrapolate a short way off the nearest end, no further.
  let x0: number, iv0: number, x1: number, iv1: number, distance: number;
  if (target < points[0][0]) {
    [[x0, iv0], [x1, iv1]] = [points[0], points[1]];
    distance = points[0][0] - target;
  } else {
    [[x0, iv0], [x1, iv1]] = [points[points.length - 2], points[points.length - 1]];
    distance = target - points[points.length - 1][0];
  }
  if (distance > MAX_EXTRAP_DISTANCE || x1 === x0) return null;
  return iv0 + ((target - x0) / (x1 - x0)) * (iv1 - iv0);
}

/** Everything `computeSkew` needs about one candidate, chosen when its chain was in hand. */
export type SkewInputs = {
  ticker: string;
  calls: SkewStrike[];
  puts: SkewStrike[];
  /** Time to expiration in years, ACT/365. */
  t: number;
  riskFreeRate: number;
  /** The at-the-money vol the strike selection was seeded from. */
  seed: number;
};

/**
 * The skew ratio in [-1, 1], or null with the reasons it could not be resolved.
 * A side that cannot be resolved yields a blank cell, never a guess.
 */
export function computeSkew(
  inputs: SkewInputs | null | undefined,
  quotes: Map<string, SkewQuote>,
  spot: number | null | undefined,
): { skew: number | null; messages: string[] } {
  const messages: string[] = [];
  if (!inputs || !inputs.calls.length || !inputs.puts.length || !spot) {
    return { skew: null, messages };
  }
  const { t, riskFreeRate: r } = inputs;
  const q = DIVIDEND_YIELD;

  const ivs: Record<"call" | "put", number | null> = { call: null, put: null };
  for (const [side, isCall, entries] of [
    ["call", true, inputs.calls],
    ["put", false, inputs.puts],
  ] as const) {
    const points = solveSide(isCall, entries, quotes, spot, t, r, q);
    const iv = interpolateIvAtDelta(points, q, t);
    if (iv === null) {
      // |delta| = exp(-qt) * N(x) on both sides, by construction of x.
      const deltas = points.map(([x]) => Math.exp(-q * t) * normCdf(x));
      const span = deltas.length
        ? `${Math.min(...deltas).toFixed(2)}-${Math.max(...deltas).toFixed(2)}`
        : "none";
      // Terser than the Python script's stderr line: this one has to fit a phone-width
      // row in the Skipped list, which renders each entry on a single line.
      messages.push(
        `no 25d ${side} vol (${points.length} strikes, \u03b4 ${span}, seed ${inputs.seed.toFixed(3)})`,
      );
    }
    ivs[side] = iv;
  }

  if (ivs.call === null || ivs.put === null) return { skew: null, messages };
  const total = ivs.call + ivs.put;
  if (total <= 0) return { skew: null, messages };
  return { skew: (ivs.call - ivs.put) / total, messages };
}
