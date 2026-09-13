/**
 * The numerics scipy supplies on the Python side of the scan: `scipy.stats.norm`
 * and `scipy.optimize.brentq`. Nothing here is scan-specific; the skew logic that
 * uses it lives in ./skew.ts.
 */

const SQRT_2PI = Math.sqrt(2 * Math.PI);

/**
 * Standard normal CDF, Hart's rational approximation as given by West (2005).
 * Accurate to roughly double precision across the whole line, which matters
 * because the vol solve inverts this function and a cheap 1e-7 erf would put
 * that error straight into the implied vol.
 */
export function normCdf(x: number): number {
  const z = Math.abs(x);
  let c: number;
  if (z > 37) {
    c = 0;
  } else {
    const e = Math.exp((-z * z) / 2);
    if (z < 7.07106781186547) {
      let b = 3.52624965998911e-2 * z + 0.700383064443688;
      b = b * z + 6.37396220353165;
      b = b * z + 33.912866078383;
      b = b * z + 112.079291497871;
      b = b * z + 221.213596169931;
      b = b * z + 220.206867912376;
      let d = 8.83883476483184e-2 * z + 1.75566716318264;
      d = d * z + 16.064177579207;
      d = d * z + 86.7807322029461;
      d = d * z + 296.564248779674;
      d = d * z + 637.333633378831;
      d = d * z + 793.826512519948;
      d = d * z + 440.413735824752;
      c = (e * b) / d;
    } else {
      let b = z + 0.65;
      b = z + 4 / b;
      b = z + 3 / b;
      b = z + 2 / b;
      b = z + 1 / b;
      c = e / (b * SQRT_2PI);
    }
  }
  return x > 0 ? 1 - c : c;
}

export function normPdf(x: number): number {
  return Math.exp((-x * x) / 2) / SQRT_2PI;
}

// Acklam's rational approximation, good to about 1.15e-9 before refinement.
const PPF_A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
  -3.066479806614716e1, 2.506628277459239,
];
const PPF_B = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
  -1.328068155288572e1,
];
const PPF_C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
  4.374664141464968, 2.938163982698783,
];
const PPF_D = [
  7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416,
];
const PPF_LOW = 0.02425;

/**
 * Standard normal quantile: Acklam's approximation, then one Halley step against
 * `normCdf` to bring it to full double precision.
 */
export function normPpf(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;

  let x: number;
  if (p < PPF_LOW) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((PPF_C[0] * q + PPF_C[1]) * q + PPF_C[2]) * q + PPF_C[3]) * q + PPF_C[4]) * q +
        PPF_C[5]) /
      ((((PPF_D[0] * q + PPF_D[1]) * q + PPF_D[2]) * q + PPF_D[3]) * q + 1);
  } else if (p <= 1 - PPF_LOW) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((PPF_A[0] * r + PPF_A[1]) * r + PPF_A[2]) * r + PPF_A[3]) * r + PPF_A[4]) * r +
        PPF_A[5]) *
        q) /
      (((((PPF_B[0] * r + PPF_B[1]) * r + PPF_B[2]) * r + PPF_B[3]) * r + PPF_B[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(((((PPF_C[0] * q + PPF_C[1]) * q + PPF_C[2]) * q + PPF_C[3]) * q + PPF_C[4]) * q +
        PPF_C[5]) /
      ((((PPF_D[0] * q + PPF_D[1]) * q + PPF_D[2]) * q + PPF_D[3]) * q + 1);
  }

  const e = normCdf(x) - p;
  const u = e * SQRT_2PI * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

/**
 * Brent's method, matching `scipy.optimize.brentq`: returns the root of `f` in
 * [a, b] to within `xtol`, or null when the bracket is not sign-changing (scipy
 * raises ValueError there, which the caller already treats as "no solution").
 */
export function brentq(
  f: (x: number) => number,
  a: number,
  b: number,
  xtol = 1e-6,
  maxIter = 100,
): number | null {
  let xpre = a;
  let xcur = b;
  let fpre = f(xpre);
  let fcur = f(xcur);
  if (fpre === 0) return xpre;
  if (fcur === 0) return xcur;
  if (!Number.isFinite(fpre) || !Number.isFinite(fcur) || fpre * fcur > 0) return null;

  let xblk = 0;
  let fblk = 0;
  let spre = 0;
  let scur = 0;

  for (let i = 0; i < maxIter; i++) {
    if (fpre * fcur < 0) {
      xblk = xpre;
      fblk = fpre;
      spre = scur = xcur - xpre;
    }
    if (Math.abs(fblk) < Math.abs(fcur)) {
      xpre = xcur;
      xcur = xblk;
      xblk = xpre;
      fpre = fcur;
      fcur = fblk;
      fblk = fpre;
    }

    const delta = xtol / 2 + 2e-12 * Math.abs(xcur);
    const sbis = (xblk - xcur) / 2;
    if (fcur === 0 || Math.abs(sbis) < delta) return xcur;

    if (Math.abs(spre) > delta && Math.abs(fcur) < Math.abs(fpre)) {
      let stry: number;
      if (xpre === xblk) {
        // Secant.
        stry = (-fcur * (xcur - xpre)) / (fcur - fpre);
      } else {
        // Inverse quadratic.
        const dpre = (fpre - fcur) / (xpre - xcur);
        const dblk = (fblk - fcur) / (xblk - xcur);
        stry = (-fcur * (fblk * dblk - fpre * dpre)) / (dblk * dpre * (fblk - fpre));
      }
      if (2 * Math.abs(stry) < Math.min(Math.abs(spre), 3 * Math.abs(sbis) - delta)) {
        spre = scur;
        scur = stry;
      } else {
        spre = sbis;
        scur = sbis;
      }
    } else {
      spre = sbis;
      scur = sbis;
    }

    xpre = xcur;
    fpre = fcur;
    xcur += Math.abs(scur) > delta ? scur : sbis > 0 ? delta : -delta;
    fcur = f(xcur);
    if (!Number.isFinite(fcur)) return null;
  }
  return xcur;
}

// Black-Scholes with a continuous dividend yield. European, while US equity
// options are American - see the `skew` column notes in the repo README for the
// size and direction of the resulting bias.

export function bsD1(
  s: number,
  k: number,
  t: number,
  r: number,
  q: number,
  sigma: number,
): number {
  return (Math.log(s / k) + (r - q + (sigma * sigma) / 2) * t) / (sigma * Math.sqrt(t));
}

export function bsPrice(
  isCall: boolean,
  s: number,
  k: number,
  t: number,
  r: number,
  q: number,
  sigma: number,
): number {
  const d1 = bsD1(s, k, t, r, q, sigma);
  const d2 = d1 - sigma * Math.sqrt(t);
  if (isCall) {
    return s * Math.exp(-q * t) * normCdf(d1) - k * Math.exp(-r * t) * normCdf(d2);
  }
  return k * Math.exp(-r * t) * normCdf(-d2) - s * Math.exp(-q * t) * normCdf(-d1);
}

export function bsDelta(
  isCall: boolean,
  s: number,
  k: number,
  t: number,
  r: number,
  q: number,
  sigma: number,
): number {
  const d1 = bsD1(s, k, t, r, q, sigma);
  return Math.exp(-q * t) * (isCall ? normCdf(d1) : normCdf(d1) - 1);
}

/**
 * Per 1.00 of vol, and per contract: 100 shares, so a vega of 1.0 is a cent of
 * option price per vol point.
 */
export function bsVega(
  s: number,
  k: number,
  t: number,
  r: number,
  q: number,
  sigma: number,
): number {
  const d1 = bsD1(s, k, t, r, q, sigma);
  return s * Math.exp(-q * t) * normPdf(d1) * Math.sqrt(t) * 100;
}

export function europeanLowerBound(
  isCall: boolean,
  s: number,
  k: number,
  t: number,
  r: number,
  q: number,
): number {
  const forward = s * Math.exp(-q * t);
  const discountedStrike = k * Math.exp(-r * t);
  return Math.max(0, isCall ? forward - discountedStrike : discountedStrike - forward);
}
