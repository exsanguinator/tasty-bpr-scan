import type { ScanRow } from "./columns";
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
export type ScanResult = { rows: ScanRow[]; skipped: Skipped[]; ranAt: number };

export type ScanOptions = {
  accountNumber: string;
  watchlists: string[];
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
  for (const [i, chunk] of metricChunks.entries()) {
    report("metrics", i, metricChunks.length);
    const resp = await get("/market-metrics", { symbols: chunk.join(",") }, signal);
    for (const item of resp.data.items) {
      const ivr = item["implied-volatility-index-rank"];
      if (ivr != null) ivrByTicker.set(item.symbol, parseFloat(ivr));
      const ivx = item["implied-volatility-index"];
      if (ivx != null) ivxByTicker.set(item.symbol, parseFloat(ivx));
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

  // Underlying quotes, 52-week ranges and previous closes.
  throwIfAborted(signal);
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
      };
    },
    () => report("chains", ++chainsDone, tickers.length),
  );
  const candidates = candidateResults.filter((c): c is Candidate => c !== null);

  // Option quotes for each candidate put.
  throwIfAborted(signal);
  const optionSymbols = candidates.map((c) => c.putSymbol).sort();
  const optionChunks = chunked(optionSymbols, CHUNK_SIZE);
  const optionMids = new Map<string, number | null>();
  for (const [i, chunk] of optionChunks.entries()) {
    report("option-quotes", i, optionChunks.length);
    const resp = await get("/market-data/by-type", { "equity-option": chunk.join(",") }, signal);
    for (const item of resp.data.items as Quote[]) optionMids.set(item.symbol, mid(item));
  }
  report("option-quotes", optionChunks.length, optionChunks.length);

  // Dry-run a 1-lot sell-to-open for each candidate to get its marginal BP impact.
  throwIfAborted(signal);
  let dryRunsDone = 0;
  report("dry-runs", 0, candidates.length);
  const rowResults = await pMap<Candidate, ScanRow | null>(
    candidates,
    CONCURRENCY,
    async (c) => {
      throwIfAborted(signal);
      const creditMid = optionMids.get(c.putSymbol);
      if (creditMid == null) {
        skipped.push({ ticker: c.ticker, reason: "no option quote" });
        return null;
      }
      let resp;
      try {
        resp = await postDryRun(
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
      } catch (error) {
        if (isAbortError(error)) throw error;
        skipped.push({ ticker: c.ticker, reason: `dry-run failed: ${errorReason(error)}` });
        return null;
      }
      const marginalBp = extractMarginalBuyingPower(resp);
      if (marginalBp === null) {
        const errors = resp?.error?.errors ?? [];
        const hard = errors.filter((e: any) => e.code !== "margin_check_failed");
        skipped.push({
          ticker: c.ticker,
          reason: hard.length
            ? `preflight error: ${hard.map((e: any) => e.message ?? e.code).join("; ")}`
            : "could not extract margin requirement",
        });
        return null;
      }
      if (marginalBp <= 0) {
        skipped.push({
          ticker: c.ticker,
          reason: "$0 incremental margin requirement (ample buying-power cushion)",
        });
        return null;
      }
      const credit = creditMid * 100;
      const notional = c.strike * 100;
      return {
        ticker: c.ticker,
        expiration: c.expiration,
        dte: c.dte,
        strike: c.strike,
        strike52wkPct: c.strike52wkPosition === null ? null : c.strike52wkPosition * 100,
        chgPct: c.chg === null ? null : c.chg * 100,
        credit,
        buyingPower: marginalBp,
        creditToBpr: (credit / marginalBp) * 100,
        bprToNotional: (marginalBp / notional) * 100,
        creditToNotional: (credit / notional) * 100,
        ivr: ivrByTicker.has(c.ticker) ? ivrByTicker.get(c.ticker)! * 100 : null,
        ivx: ivxByTicker.has(c.ticker) ? ivxByTicker.get(c.ticker)! * 100 : null,
        putSymbol: c.putSymbol,
      };
    },
    () => report("dry-runs", ++dryRunsDone, candidates.length),
  );

  const rows = rowResults
    .filter((r): r is ScanRow => r !== null)
    .sort((a, b) => b.creditToBpr - a.creditToBpr);

  report("done", 1, 1);
  skipped.sort((a, b) => a.ticker.localeCompare(b.ticker));
  return { rows, skipped, ranAt: Date.now() };
}

/** First present of the isolated/change keys wins, as an absolute dollar amount. */
function extractMarginalBuyingPower(resp: any): number | null {
  const bpe = resp?.data?.["buying-power-effect"] ?? {};
  for (const key of [
    "isolated-order-margin-requirement",
    "change-in-buying-power",
    "change-in-margin-requirement",
  ]) {
    if (key in bpe) return Math.abs(parseFloat(bpe[key]));
  }
  return null;
}
