import type { ScanRow } from "./columns";
import {
  DEFAULT_RISK_FREE_RATE,
  DIVIDEND_YIELD,
  EQUITY_MULTIPLIER,
  computeSkew,
  selectSkewStrikes,
  type SkewInputs,
} from "./skew";
import { get, postDryRun } from "./tastyClient";

const TARGET_DTE = 45;
const MIN_LIQUIDITY_RATING = 2;
// Futures ratings run lower than equities for products with perfectly tradeable
// options (/NQ rates 1). A null rating means the product has no options at all
// (/YM), so it still excludes.
const MIN_FUTURES_LIQUIDITY_RATING = 1;
// Futures products list their monthlies either as Regular (LO on /CL, OZN on /ZN)
// or as End-Of-Month (EW on /ES, whose Regular expirations are the quarterlies).
const EQUITY_MONTHLY_TYPES = new Set(["Regular"]);
const FUTURES_MONTHLY_TYPES = new Set(["Regular", "End-Of-Month"]);
// Micro futures (/MES, /MNQ) list a single near End-Of-Month and a quarterly, so
// their nearest monthly can be days from expiry while weeklies sit near 45 DTE.
// Past this many days from TARGET_DTE, futures take the nearest expiration of any
// type instead.
const MAX_FUTURES_MONTHLY_DISTANCE = 15;
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
/**
 * Futures options always come back with isolated-order-margin-requirement 0.0 and
 * effect None, so isolated mode reads the order's change in margin requirement
 * instead: still margin only, gross of the credit, but measured against the
 * account's existing positions rather than on its own.
 */
export const FUTURES_BPR_MODES: Record<BprMode, string> = {
  isolated: "change-in-margin-requirement",
  impact: "change-in-buying-power",
};

function bprKey(bprMode: BprMode, future: boolean): string {
  return (future ? FUTURES_BPR_MODES : BPR_MODES)[bprMode];
}

/**
 * Futures products and contracts are the only watchlist symbols with a leading
 * slash (/ES, /ESZ6).
 */
function isFuture(symbol: string): boolean {
  return symbol.startsWith("/");
}

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

type TickSize = { threshold?: string; value: string };

/**
 * Rounds to the nearest valid tick. tickSizes is a futures chain expiration's
 * tick-sizes list: each entry applies below its threshold, and the last one, with
 * no threshold, applies above them all. null means an equity option.
 */
function formatLimitPrice(price: number, tickSizes: TickSize[] | null): string {
  if (!tickSizes?.length) return roundToNickel(price).toFixed(2);
  const tick = (
    tickSizes.find((t) => t.threshold == null || price < parseFloat(t.threshold)) ??
    tickSizes[tickSizes.length - 1]
  ).value;
  const decimals = tick.includes(".") ? tick.split(".")[1].replace(/0+$/, "").length : 0;
  const size = parseFloat(tick);
  return (Math.round(price / size) * size).toFixed(Math.max(decimals, 2));
}

/**
 * Nearest-to-TARGET_DTE monthly, or the nearest of any type when there is no
 * monthly or, with maxMonthlyDistance set, none that close to the target.
 */
function pickExpiration(
  expirations: any[],
  monthlyTypes: Set<string>,
  maxMonthlyDistance: number | null = null,
): any {
  const distance = (e: any) => Math.abs(e["days-to-expiration"] - TARGET_DTE);
  const nearest = (list: any[]) => list.reduce((best, e) => (distance(e) < distance(best) ? e : best));
  const monthly = expirations.filter((e) => monthlyTypes.has(e["expiration-type"]));
  if (monthly.length > 0) {
    const best = nearest(monthly);
    if (maxMonthlyDistance === null || distance(best) <= maxMonthlyDistance) return best;
  }
  return nearest(expirations);
}

/**
 * Dollars per point of option price. The futures chain gives no multiplier
 * directly, but notional-value is quoted per display-factor price unit: /ES
 * 0.5 / 0.01 = 50, /CL 10 / 0.01 = 1000, /ZN 1000 / 1 = 1000.
 */
function contractMultiplier(expiration: any, future: boolean): number {
  if (!future) return EQUITY_MULTIPLIER;
  return parseFloat(expiration["notional-value"]) / parseFloat(expiration["display-factor"]);
}

type UnderlyingQuotes = {
  mids: Map<string, number | null>;
  ranges: Map<string, [number, number]>;
  prevCloses: Map<string, number>;
};

/**
 * Quotes for equities and futures contracts (/ESZ6, not the /ES product), one
 * request per chunk. Futures quotes carry no 52-week range.
 */
async function fetchUnderlyingQuotes(
  symbols: string[],
  signal?: AbortSignal,
  onChunk?: (done: number, total: number) => void,
): Promise<UnderlyingQuotes> {
  const jobs = [
    ...chunked(symbols.filter((s) => !isFuture(s)).sort(), CHUNK_SIZE).map((chunk) => ({ param: "equity", chunk })),
    ...chunked(symbols.filter(isFuture).sort(), CHUNK_SIZE).map((chunk) => ({ param: "future", chunk })),
  ];
  const out: UnderlyingQuotes = { mids: new Map(), ranges: new Map(), prevCloses: new Map() };
  for (const [i, { param, chunk }] of jobs.entries()) {
    onChunk?.(i, jobs.length);
    const resp = await get("/market-data/by-type", { [param]: chunk.join(",") }, signal);
    for (const item of resp.data.items as Quote[]) {
      out.mids.set(item.symbol, mid(item));
      const low = item["year-low-price"];
      const high = item["year-high-price"];
      if (low != null && high != null) {
        out.ranges.set(item.symbol, [parseFloat(low), parseFloat(high)]);
      }
      const prevClose = item["prev-close"];
      if (prevClose != null) out.prevCloses.set(item.symbol, parseFloat(prevClose));
    }
  }
  onChunk?.(jobs.length, jobs.length);
  return out;
}

/**
 * The chain's expirations. A futures chain spans every contract month, so each of
 * its expirations names its own underlying contract (/ESZ6).
 */
async function fetchExpirations(ticker: string, signal?: AbortSignal): Promise<any[]> {
  if (isFuture(ticker)) {
    const resp = await get(`/futures-option-chains/${ticker.slice(1)}/nested`, undefined, signal);
    return (resp.data["option-chains"] ?? []).flatMap((chain: any) => chain.expirations ?? []);
  }
  const resp = await get(`/option-chains/${ticker}/nested`, undefined, signal);
  return resp.data.items?.[0]?.expirations ?? [];
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
      const kind = entry["instrument-type"];
      if (kind === "Equity" && !entry.symbol.endsWith(".IVR")) {
        tickers.add(entry.symbol);
      } else if (kind === "Future" && isFuture(entry.symbol)) {
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
      const minimum = isFuture(item.symbol) ? MIN_FUTURES_LIQUIDITY_RATING : MIN_LIQUIDITY_RATING;
      if (rating != null && rating >= minimum) {
        kept.push(item.symbol);
      } else if (rating == null) {
        skipped.push({ ticker: item.symbol, reason: "no liquidity-rating" });
      } else {
        skipped.push({ ticker: item.symbol, reason: `liquidity-rating ${rating} < ${minimum}` });
      }
    }
  }
  for (const ticker of tickers) {
    if (!expIvsByTicker.has(ticker)) skipped.push({ ticker, reason: "no market metrics" });
  }
  report("metrics", metricChunks.length, metricChunks.length);
  tickers = kept.sort();

  // Rate for the skew's Black-Scholes inversion.
  throwIfAborted(signal);
  const riskFreeRate = await fetchRiskFreeRate(signal);

  // Underlying quotes, 52-week ranges and previous closes. Equities only: futures
  // fetch their own contract's quote once the expiration is picked.
  const equityQuotes = await fetchUnderlyingQuotes(
    tickers.filter((t) => !isFuture(t)),
    signal,
    (done, total) => report("quotes", done, total),
  );

  /**
   * Chooses which strikes the skew will need quotes for. Runs while the chain is
   * already in hand, so strike selection costs no request; only the quotes do.
   */
  const pickSkewStrikes = (
    ticker: string,
    expiration: any,
    spot: number,
    multiplier: number,
  ): SkewInputs | null => {
    const date = String(expiration["expiration-date"]).slice(0, 10);
    const seed = expIvsByTicker.get(ticker)?.get(date) || ivxByTicker.get(ticker);
    if (!seed) {
      skipped.push({ ticker, reason: `skew: no seed IV for ${date}` });
      return null;
    }
    // Calendar time, matching the ACT/365 convention behind the ivx column.
    const t = Math.max(expiration["days-to-expiration"], 1) / 365;
    // q = r makes the forward the futures price itself (Black-76).
    const q = isFuture(ticker) ? riskFreeRate : DIVIDEND_YIELD;
    const { calls, puts } = selectSkewStrikes(expiration.strikes, spot, t, riskFreeRate, q, seed);
    if (!calls.length || !puts.length) {
      skipped.push({ ticker, reason: "skew: too few strikes near 25 delta" });
      return null;
    }
    return { ticker, calls, puts, t, riskFreeRate, q, multiplier, seed };
  };

  // Per ticker: nearest-to-45-DTE expiration, nearest OTM put strike.
  throwIfAborted(signal);
  type Candidate = {
    ticker: string;
    /** The ticker for equities; the picked expiration's contract (/ESZ6) for futures. */
    underlyingSymbol: string;
    underlyingMid: number;
    /** Dollars per point of option price. */
    multiplier: number;
    optionInstrumentType: "Equity Option" | "Future Option";
    /** Futures tick sizes vary by product; null keeps equities on a nickel. */
    tickSizes: TickSize[] | null;
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
      const future = isFuture(ticker);
      if (!future && equityQuotes.mids.get(ticker) == null) {
        skipped.push({ ticker, reason: "no underlying quote" });
        return null;
      }
      let expirations: any[];
      try {
        expirations = await fetchExpirations(ticker, signal);
      } catch (error) {
        if (isAbortError(error)) throw error;
        skipped.push({ ticker, reason: `option chain fetch failed: ${errorReason(error)}` });
        return null;
      }
      if (!expirations.length) {
        skipped.push({ ticker, reason: "no expirations found" });
        return null;
      }
      // Weeklies are an equity liquidity screen. Plenty of liquid futures products
      // (/ZS, /6E, /NG) list none, so futures rely on the liquidity rating alone.
      if (!future && !expirations.some((e) => e["expiration-type"] === "Weekly")) {
        skipped.push({ ticker, reason: "no weekly options" });
        return null;
      }
      const expiration = future
        ? pickExpiration(expirations, FUTURES_MONTHLY_TYPES, MAX_FUTURES_MONTHLY_DISTANCE)
        : pickExpiration(expirations, EQUITY_MONTHLY_TYPES);
      const underlyingSymbol: string = future ? expiration["underlying-symbol"] : ticker;
      const quotes = future ? await fetchUnderlyingQuotes([underlyingSymbol], signal) : equityQuotes;
      const underlyingMid = quotes.mids.get(underlyingSymbol);
      if (underlyingMid == null) {
        skipped.push({ ticker, reason: `no underlying quote for ${underlyingSymbol}` });
        return null;
      }
      const multiplier = contractMultiplier(expiration, future);
      const otm = (expiration.strikes as any[])
        .map((s) => ({ ...s, price: parseFloat(s["strike-price"]) }))
        .sort((a, b) => a.price - b.price)
        .filter((s) => s.price < underlyingMid);
      if (otm.length === 0) {
        skipped.push({ ticker, reason: "no OTM put strike found" });
        return null;
      }
      const strike = otm[otm.length - 1];
      const range = quotes.ranges.get(underlyingSymbol);
      return {
        ticker,
        underlyingSymbol,
        underlyingMid,
        multiplier,
        optionInstrumentType: future ? "Future Option" : "Equity Option",
        tickSizes: future ? (expiration["tick-sizes"] ?? null) : null,
        expiration: expiration["expiration-date"],
        dte: expiration["days-to-expiration"],
        strike: strike.price,
        putSymbol: strike.put,
        strike52wkPosition: range ? strikePositionIn52wkRange(strike.price, range) : null,
        chg: changeFromPrevClose(underlyingMid, quotes.prevCloses.get(underlyingSymbol)),
        skewInputs: pickSkewStrikes(ticker, expiration, underlyingMid, multiplier),
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
  // Futures option symbols start with "./" (./ESZ6 EW1X6 261106P7625).
  const isFutureOption = (symbol: string) => symbol.startsWith("./");
  // The underlying mids above are stale by a whole chain-fetch phase, and a wrong
  // spot moves call and put implied vol in opposite directions, landing straight on
  // the skew. These chunks buy a spot contemporaneous with the option quotes.
  const spotSymbols = [...new Set(candidates.map((c) => c.underlyingSymbol))].sort();
  const jobsFor = (param: string, symbols: string[]) =>
    chunked(symbols, CHUNK_SIZE).map((chunk) => ({ param, chunk }));
  const quoteJobs = [
    ...jobsFor("equity-option", optionSymbols.filter((s) => !isFutureOption(s))),
    ...jobsFor("future-option", optionSymbols.filter(isFutureOption)),
    ...jobsFor("equity", spotSymbols.filter((s) => !isFuture(s))),
    ...jobsFor("future", spotSymbols.filter(isFuture)),
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
        if (param.endsWith("-option")) optionQuotes.set(item.symbol, item);
        else skewSpots.set(item.symbol, mid(item));
      }
    },
    () => report("option-quotes", ++quoteChunksDone, quoteJobs.length),
  );
  report("option-quotes", quoteJobs.length, quoteJobs.length);

  // Skew, from the quotes just fetched. A skew that cannot be resolved blanks that
  // one cell and notes why; it never drops the row.
  for (const c of candidates) {
    const spot = skewSpots.get(c.underlyingSymbol) ?? c.underlyingMid;
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
      const field = bprKey(bprMode, isFuture(c.ticker));
      let marginalBp: number | null = null;
      try {
        const resp = await postDryRun(
          `/accounts/${accountNumber}/orders/dry-run`,
          {
            "order-type": "Limit",
            price: formatLimitPrice(creditMid, c.tickSizes),
            "price-effect": "Credit",
            "time-in-force": "Day",
            legs: [
              {
                "instrument-type": c.optionInstrumentType,
                symbol: c.putSymbol,
                quantity: "1",
                action: "Sell to Open",
              },
            ],
          },
          signal,
        );
        marginalBp = extractMarginalBuyingPower(resp, field);
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
      const credit = creditMid * c.multiplier;
      const notional = c.strike * c.multiplier;
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
 * The selected buying-power-effect field (see bprKey), signed. Amounts are
 * unsigned with the direction in a sibling -effect field; a Credit means the order
 * frees buying power (e.g. a credit larger than the margin it adds), so it comes
 * back negative.
 */
export function extractMarginalBuyingPower(resp: any, key: string): number | null {
  const bpe = resp?.data?.["buying-power-effect"] ?? {};
  const errors: any[] = resp?.error?.errors ?? [];
  const hard = errors.filter((e) => e.code !== "margin_check_failed");
  if (hard.length && Object.keys(bpe).length === 0) return null;
  const amount = bpe[key] == null ? NaN : Math.abs(parseFloat(bpe[key]));
  if (!Number.isFinite(amount)) return null;
  // The `&& amount` keeps a zero Credit from becoming -0.
  return bpe[`${key}-effect`] === "Credit" && amount ? -amount : amount;
}
