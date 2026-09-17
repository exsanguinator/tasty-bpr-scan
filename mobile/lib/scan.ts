import type { ScanRow } from "./columns";
import {
  DEFAULT_RISK_FREE_RATE,
  DIVIDEND_YIELD,
  computeSkew,
  selectSkewStrikes,
  type SkewInputs,
} from "./skew";
import { get, postDryRun } from "./tastyClient";

const TARGET_DTE = 45;
const MIN_LIQUIDITY_RATING = 2;
/** Chunk size for the batched market-data / market-metrics endpoints. */
const CHUNK_SIZE = 100;
/** Parallel in-flight requests for the per-ticker chain fetch and dry-run phases. */
const CONCURRENCY = 5;

export type ScanPhase =
  | "watchlists"
  | "metrics"
  | "quotes"
  | "chains"
  | "option-quotes"
  | "dry-runs"
  | "done";

export const PHASE_LABELS: Record<ScanPhase, string> = {
  watchlists: "Resolving watchlists",
  metrics: "Fetching market metrics",
  quotes: "Fetching underlying quotes",
  chains: "Fetching option chains",
  "option-quotes": "Fetching option quotes",
  "dry-runs": "Dry-running orders",
  done: "Done",
};

export type Progress = { phase: ScanPhase; done: number; total: number };
export type Skipped = { ticker: string; reason: string };

/**
 * buying-power-effect field each BPR mode reads, matching scan-put-bp.py's
 * --bpr-isolated / --bpr-impact. isolated is the order's margin requirement on its
 * own; impact is the account's actual buying-power change, which nets the premium
 * received and fees against the margin change.
 */
export const BPR_MODES = {
  isolated: "isolated-order-margin-requirement",
  impact: "change-in-buying-power",
} as const;
export type BprMode = keyof typeof BPR_MODES;
export const DEFAULT_BPR_MODE: BprMode = "isolated";

export type ScanResult = {
  rows: ScanRow[];
  skipped: Skipped[];
  ranAt: number;
  /** Absent on a result cached by a build that predates the setting. */
  bprMode?: BprMode;
};

export type ScanOptions = {
  accountNumber: string;
  watchlists: string[];
  bprMode?: BprMode;
  onProgress?: (progress: Progress) => void;
  signal?: AbortSignal;
};

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving input order. */
async function pMap<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onEach?: () => void,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
      onEach?.();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Scan cancelled", "AbortError");
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Quote = {
  symbol: string;
  bid?: string | null;
  ask?: string | null;
  last?: string | null;
  "year-low-price"?: string | null;
  "year-high-price"?: string | null;
  "prev-close"?: string | null;
};

/** Bid/ask midpoint, falling back to last. */
function mid(item: Quote): number | null {
  if (item.bid != null && item.ask != null) {
    return (parseFloat(item.bid) + parseFloat(item.ask)) / 2;
  }
  return item.last != null ? parseFloat(item.last) : null;
}

/** 0 = strike at the 52-week low, 1 = strike at the 52-week high. */
function strikePositionIn52wkRange(strike: number, [low, high]: [number, number]): number | null {
  if (high === low) return null;
  return (strike - low) / (high - low);
}

/** Fraction the underlying's mid has moved from the previous day's close. */
function changeFromPrevClose(underlyingMid: number, prevClose: number | undefined): number | null {
  if (prevClose == null || prevClose === 0) return null;
  return (underlyingMid - prevClose) / prevClose;
}

function roundToNickel(price: number): number {
  return Math.round(price / 0.05) * 0.05;
}

/**
 * /margin-requirements-public-configuration needs no auth and the API docs endorse
 * its rate as a Black-Scholes input. Falls back to a constant rather than failing
 * the scan, since skew barely moves with a few bps of error.
 */
async function fetchRiskFreeRate(signal?: AbortSignal): Promise<number> {
  try {
    const resp = await get("/margin-requirements-public-configuration", undefined, signal);
    const rate = parseFloat(resp.data["risk-free-rate"]);
    if (Number.isFinite(rate)) return rate;
  } catch (error) {
    if (isAbortError(error)) throw error;
  }
  return DEFAULT_RISK_FREE_RATE;
}

export type Account = { accountNumber: string; nickname: string };

export async function fetchAccounts(signal?: AbortSignal): Promise<Account[]> {
  const resp = await get("/customers/me/accounts", undefined, signal);
  return resp.data.items.map((item: any) => ({
    accountNumber: item.account["account-number"],
    nickname: item.account.nickname ?? item.account["account-type-name"] ?? "",
  }));
}

export type Watchlist = { name: string; entryCount: number };

export async function fetchWatchlists(signal?: AbortSignal): Promise<Watchlist[]> {
  const resp = await get("/watchlists", undefined, signal);
  return resp.data.items
    .map((item: any) => ({
      name: item.name,
      entryCount: (item["watchlist-entries"] ?? []).length,
    }))
    .sort((a: Watchlist, b: Watchlist) => a.name.localeCompare(b.name));
}

async function resolveTickers(watchlistNames: string[], signal?: AbortSignal): Promise<string[]> {
  const resp = await get("/watchlists", undefined, signal);
  const wanted = new Set(watchlistNames);
  const tickers = new Set<string>();
  for (const item of resp.data.items) {
    if (!wanted.has(item.name)) continue;
    for (const entry of item["watchlist-entries"] ?? []) {
      if (entry["instrument-type"] === "Equity" && !entry.symbol.endsWith(".IVR")) {
        tickers.add(entry.symbol);
      }
    }
  }
  return [...tickers].sort();
}

export async function runScan({
  accountNumber,
  watchlists,
  bprMode = DEFAULT_BPR_MODE,
  onProgress,
  signal,
}: ScanOptions): Promise<ScanResult> {
  const skipped: Skipped[] = [];
  const report = (phase: ScanPhase, done: number, total: number) =>
    onProgress?.({ phase, done, total });

  report("watchlists", 0, 1);
  let tickers = await resolveTickers(watchlists, signal);
  report("watchlists", 1, 1);

  // Liquidity filter, which also supplies the ivr / ivx columns.
  throwIfAborted(signal);
  const metricChunks = chunked(tickers, CHUNK_SIZE);
  const kept: string[] = [];
  const ivrByTicker = new Map<string, number>();
  const ivxByTicker = new Map<string, number>();
  const expIvsByTicker = new Map<string, Map<string, number>>();
  for (const [i, chunk] of metricChunks.entries()) {
    report("metrics", i, metricChunks.length);
    const resp = await get("/market-metrics", { symbols: chunk.join(",") }, signal);
    for (const item of resp.data.items) {
      const ivr = item["implied-volatility-index-rank"];
      if (ivr != null) ivrByTicker.set(item.symbol, parseFloat(ivr));
      const ivx = item["implied-volatility-index"];
      if (ivx != null) ivxByTicker.set(item.symbol, parseFloat(ivx));
      expIvsByTicker.set(item.symbol, expirationIvs(item));
      const rating = item["liquidity-rating"];
      if (rating != null && rating >= MIN_LIQUIDITY_RATING) {
        kept.push(item.symbol);
      } else {
        skipped.push({
          ticker: item.symbol,
          reason: `liquidity-rating ${rating} < ${MIN_LIQUIDITY_RATING}`,
        });
      }
    }
  }
  report("metrics", metricChunks.length, metricChunks.length);
  tickers = kept.sort();

  // Rate for the skew's Black-Scholes inversion.
  throwIfAborted(signal);
  const riskFreeRate = await fetchRiskFreeRate(signal);

  // Underlying quotes, 52-week ranges and previous closes.
  const quoteChunks = chunked(tickers, CHUNK_SIZE);
  const underlyingMids = new Map<string, number | null>();
  const underlyingRanges = new Map<string, [number, number]>();
  const prevCloses = new Map<string, number>();
  for (const [i, chunk] of quoteChunks.entries()) {
    report("quotes", i, quoteChunks.length);
    const resp = await get("/market-data/by-type", { equity: chunk.join(",") }, signal);
    for (const item of resp.data.items as Quote[]) {
      underlyingMids.set(item.symbol, mid(item));
      const low = item["year-low-price"];
      const high = item["year-high-price"];
      if (low != null && high != null) {
        underlyingRanges.set(item.symbol, [parseFloat(low), parseFloat(high)]);
      }
      const prevClose = item["prev-close"];
      if (prevClose != null) prevCloses.set(item.symbol, parseFloat(prevClose));
    }
  }
  report("quotes", quoteChunks.length, quoteChunks.length);

  /**
   * Chooses which strikes the skew will need quotes for. Runs while the chain is
   * already in hand, so strike selection costs no request; only the quotes do.
   */
  const pickSkewStrikes = (ticker: string, expiration: any, spot: number): SkewInputs | null => {
    const date = String(expiration["expiration-date"]).slice(0, 10);
    const seed = expIvsByTicker.get(ticker)?.get(date) || ivxByTicker.get(ticker);
    if (!seed) {
      skipped.push({ ticker, reason: `skew: no seed IV for ${date}` });
      return null;
    }
    // Calendar time, matching the ACT/365 convention behind the ivx column.
    const t = Math.max(expiration["days-to-expiration"], 1) / 365;
    const { calls, puts } = selectSkewStrikes(
      expiration.strikes,
      spot,
      t,
      riskFreeRate,
      DIVIDEND_YIELD,
      seed,
    );
    if (!calls.length || !puts.length) {
      skipped.push({ ticker, reason: "skew: too few strikes near 25 delta" });
      return null;
    }
    return { ticker, calls, puts, t, riskFreeRate, seed };
  };

  // Per ticker: nearest-to-45-DTE expiration, nearest OTM put strike.
  throwIfAborted(signal);
  type Candidate = {
    ticker: string;
    expiration: string;
    dte: number;
    strike: number;
    putSymbol: string;
    strike52wkPosition: number | null;
    chg: number | null;
    /** Strikes to quote for the skew, chosen while the chain is in hand. */
    skewInputs: SkewInputs | null;
    skew: number | null;
  };
  let chainsDone = 0;
  report("chains", 0, tickers.length);
  const candidateResults = await pMap<string, Candidate | null>(
    tickers,
    CONCURRENCY,
    async (ticker) => {
      throwIfAborted(signal);
      const underlyingMid = underlyingMids.get(ticker);
      if (underlyingMid == null) {
        skipped.push({ ticker, reason: "no underlying quote" });
        return null;
      }
      let resp;
      try {
        resp = await get(`/option-chains/${ticker}/nested`, undefined, signal);
      } catch (error) {
        if (isAbortError(error)) throw error;
        skipped.push({ ticker, reason: `option chain fetch failed: ${errorReason(error)}` });
        return null;
      }
      const items = resp.data.items;
      if (!items?.length || !items[0].expirations?.length) {
        skipped.push({ ticker, reason: "no expirations found" });
        return null;
      }
      const expirations = items[0].expirations as any[];
      if (!expirations.some((e) => e["expiration-type"] === "Weekly")) {
        skipped.push({ ticker, reason: "no weekly options" });
        return null;
      }
      const regular = expirations.filter((e) => e["expiration-type"] === "Regular");
      const candidates = regular.length > 0 ? regular : expirations;
      const expiration = candidates.reduce((best, e) =>
        Math.abs(e["days-to-expiration"] - TARGET_DTE) <
        Math.abs(best["days-to-expiration"] - TARGET_DTE)
          ? e
          : best,
      );
      const otm = (expiration.strikes as any[])
        .map((s) => ({ ...s, price: parseFloat(s["strike-price"]) }))
        .sort((a, b) => a.price - b.price)
        .filter((s) => s.price < underlyingMid);
      if (otm.length === 0) {
        skipped.push({ ticker, reason: "no OTM put strike found" });
        return null;
      }
      const strike = otm[otm.length - 1];
      const range = underlyingRanges.get(ticker);
      return {
        ticker,
        expiration: expiration["expiration-date"],
        dte: expiration["days-to-expiration"],
        strike: strike.price,
        putSymbol: strike.put,
        strike52wkPosition: range ? strikePositionIn52wkRange(strike.price, range) : null,
        chg: changeFromPrevClose(underlyingMid, prevCloses.get(ticker)),
        skewInputs: pickSkewStrikes(ticker, expiration, underlyingMid),
        skew: null,
      };
    },
    () => report("chains", ++chainsDone, tickers.length),
  );
  const candidates = candidateResults.filter((c): c is Candidate => c !== null);

  // Option quotes: each candidate put, plus every strike the skew needs. Raw items
  // are kept rather than mids, because the skew path demands a two-sided quote
  // while the credit path still tolerates a `last` fallback.
  throwIfAborted(signal);
  const skewSymbols = candidates.flatMap((c) =>
    [...(c.skewInputs?.calls ?? []), ...(c.skewInputs?.puts ?? [])].map(([, symbol]) => symbol),
  );
  const optionSymbols = [...new Set([...candidates.map((c) => c.putSymbol), ...skewSymbols])].sort();
  const optionChunks = chunked(optionSymbols, CHUNK_SIZE);
  // The underlying mids above are stale by a whole chain-fetch phase, and a wrong
  // spot moves call and put implied vol in opposite directions, landing straight on
  // the skew. These chunks buy a spot contemporaneous with the option quotes.
  const spotChunks = chunked(candidates.map((c) => c.ticker).sort(), CHUNK_SIZE);
  const quoteJobs = [
    ...optionChunks.map((chunk) => ({ param: "equity-option", chunk }) as const),
    ...spotChunks.map((chunk) => ({ param: "equity", chunk }) as const),
  ];
  const optionQuotes = new Map<string, Quote>();
  const skewSpots = new Map<string, number | null>();
  let quoteChunksDone = 0;
  report("option-quotes", 0, quoteJobs.length);
  await pMap(
    quoteJobs,
    CONCURRENCY,
    async ({ param, chunk }) => {
      throwIfAborted(signal);
      const resp = await get("/market-data/by-type", { [param]: chunk.join(",") }, signal);
      for (const item of resp.data.items as Quote[]) {
        if (param === "equity-option") optionQuotes.set(item.symbol, item);
        else skewSpots.set(item.symbol, mid(item));
      }
    },
    () => report("option-quotes", ++quoteChunksDone, quoteJobs.length),
  );
  report("option-quotes", quoteJobs.length, quoteJobs.length);

  // Skew, from the quotes just fetched. A skew that cannot be resolved blanks that
  // one cell and notes why; it never drops the row.
  for (const c of candidates) {
    const spot = skewSpots.get(c.ticker) ?? underlyingMids.get(c.ticker) ?? null;
    try {
      const { skew, messages } = computeSkew(c.skewInputs, optionQuotes, spot);
      c.skew = skew;
      for (const message of messages) skipped.push({ ticker: c.ticker, reason: `skew: ${message}` });
    } catch (error) {
      // Never let one ticker's smile kill the scan.
      c.skew = null;
      skipped.push({ ticker: c.ticker, reason: `skew failed: ${errorReason(error)}` });
    }
  }

  // Dry-run a 1-lot sell-to-open for each candidate to get its marginal BP impact.
  throwIfAborted(signal);
  let dryRunsDone = 0;
  report("dry-runs", 0, candidates.length);
  const rowResults = await pMap<Candidate, ScanRow | null>(
    candidates,
    CONCURRENCY,
    async (c) => {
      throwIfAborted(signal);
      const putQuote = optionQuotes.get(c.putSymbol);
      const creditMid = putQuote ? mid(putQuote) : null;
      if (creditMid == null) {
        skipped.push({ ticker: c.ticker, reason: "no option quote" });
        return null;
      }
      // Every candidate with a credit gets a row. When the dry-run yields no
      // buying power the buying-power columns are blank, and when it yields <= 0,
      // bpr is shown but the ratios built on it are blank. The `bpr:` entries in
      // skipped are notes on those cells, like the `skew:` ones, not skips.
      const field = BPR_MODES[bprMode];
      let marginalBp: number | null = null;
      try {
        const resp = await postDryRun(
          `/accounts/${accountNumber}/orders/dry-run`,
          {
            "order-type": "Limit",
            price: roundToNickel(creditMid).toFixed(2),
            "price-effect": "Credit",
            "time-in-force": "Day",
            legs: [
              {
                "instrument-type": "Equity Option",
                symbol: c.putSymbol,
                quantity: "1",
                action: "Sell to Open",
              },
            ],
          },
          signal,
        );
        marginalBp = extractMarginalBuyingPower(resp, bprMode);
        if (marginalBp === null) {
          const errors = resp?.error?.errors ?? [];
          const hard = errors.filter((e: any) => e.code !== "margin_check_failed");
          skipped.push({
            ticker: c.ticker,
            reason: hard.length
              ? `bpr: preflight error: ${hard.map((e: any) => e.message ?? e.code).join("; ")}`
              : `bpr: no ${field}`,
          });
        } else if (marginalBp <= 0) {
          skipped.push({ ticker: c.ticker, reason: `bpr: ${field} ${marginalBp.toFixed(2)} <= 0` });
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        skipped.push({ ticker: c.ticker, reason: `bpr: dry-run failed: ${errorReason(error)}` });
      }
      // Only a positive buying power makes a meaningful denominator.
      const ranked = marginalBp !== null && marginalBp > 0;
      const credit = creditMid * 100;
      const notional = c.strike * 100;
      return {
        ticker: c.ticker,
        expiration: c.expiration,
        dte: c.dte,
        strike: c.strike,
        strike52wkPct: c.strike52wkPosition === null ? null : c.strike52wkPosition * 100,
        chgPct: c.chg === null ? null : c.chg * 100,
        skew: c.skew === null ? null : c.skew * 100,
        credit,
        buyingPower: marginalBp,
        creditToBpr: ranked ? (credit / marginalBp!) * 100 : null,
        bprToNotional: ranked ? (marginalBp! / notional) * 100 : null,
        creditToNotional: (credit / notional) * 100,
        ivr: ivrByTicker.has(c.ticker) ? ivrByTicker.get(c.ticker)! * 100 : null,
        ivx: ivxByTicker.has(c.ticker) ? ivxByTicker.get(c.ticker)! * 100 : null,
        putSymbol: c.putSymbol,
      };
    },
    () => report("dry-runs", ++dryRunsDone, candidates.length),
  );

  // Rows with a blank creditToBpr sort after every ranked row; the sort is stable,
  // so they keep ticker order among themselves.
  const rows = rowResults
    .filter((r): r is ScanRow => r !== null)
    .sort((a, b) => {
      if (a.creditToBpr === null || b.creditToBpr === null) {
        return (a.creditToBpr === null ? 1 : 0) - (b.creditToBpr === null ? 1 : 0);
      }
      return b.creditToBpr - a.creditToBpr;
    });

  report("done", 1, 1);
  skipped.sort((a, b) => a.ticker.localeCompare(b.ticker));
  return { rows, skipped, ranAt: Date.now(), bprMode };
}

/**
 * Per-expiration implied volatilities from /market-metrics, keyed by YYYY-MM-DD:
 * market-metrics can return a full timestamp where the option chain returns a
 * plain date, so both sides are truncated to match.
 */
function expirationIvs(item: any): Map<string, number> {
  const ivs = new Map<string, number>();
  for (const entry of item["option-expiration-implied-volatilities"] ?? []) {
    const date = entry["expiration-date"];
    const iv = entry["implied-volatility"] == null ? NaN : parseFloat(entry["implied-volatility"]);
    if (date && iv) ivs.set(String(date).slice(0, 10), iv);
  }
  return ivs;
}

/**
 * The selected mode's field, signed. Amounts are unsigned with the direction in a
 * sibling -effect field; a Credit means the order frees buying power (e.g. a
 * credit larger than the margin it adds), so it comes back negative.
 */
export function extractMarginalBuyingPower(resp: any, bprMode: BprMode): number | null {
  const bpe = resp?.data?.["buying-power-effect"] ?? {};
  const errors: any[] = resp?.error?.errors ?? [];
  const hard = errors.filter((e) => e.code !== "margin_check_failed");
  if (hard.length && Object.keys(bpe).length === 0) return null;
  const key = BPR_MODES[bprMode];
  const amount = bpe[key] == null ? NaN : Math.abs(parseFloat(bpe[key]));
  if (!Number.isFinite(amount)) return null;
  // The `&& amount` keeps a zero Credit from becoming -0.
  return bpe[`${key}-effect`] === "Credit" && amount ? -amount : amount;
}
