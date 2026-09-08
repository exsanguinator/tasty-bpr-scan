export type ScanRow = {
  ticker: string;
  expiration: string;
  dte: number;
  strike: number;
  /** Where the strike sits in the underlying's 52-week range, as a percentage. */
  strike52wkPct: number | null;
  /** Estimated premium for 1 contract, in dollars. */
  credit: number;
  /** Marginal buying-power requirement this order adds, from the dry-run. */
  buyingPower: number;
  creditToBpr: number;
  bprToNotional: number;
  creditToNotional: number;
  ivr: number | null;
  ivx: number | null;
  putSymbol: string;
};

export type ColumnKey = keyof Omit<ScanRow, "putSymbol">;

export type Column = {
  key: ColumnKey;
  label: string;
  width: number;
  numeric: boolean;
  format: (row: ScanRow) => string;
};

/** Matches the Python script's zero-padded 1-decimal formatting. */
const oneDecimal = (value: number | null): string => (value === null ? "" : value.toFixed(1));

export const COLUMNS: Column[] = [
  { key: "expiration", label: "expiration", width: 92, numeric: false, format: (r) => r.expiration },
  { key: "dte", label: "dte", width: 46, numeric: true, format: (r) => String(r.dte) },
  { key: "strike", label: "strike", width: 66, numeric: true, format: (r) => String(r.strike) },
  { key: "strike52wkPct", label: "52wk %", width: 74, numeric: true, format: (r) => oneDecimal(r.strike52wkPct) },
  { key: "credit", label: "credit", width: 66, numeric: true, format: (r) => oneDecimal(r.credit) },
  { key: "buyingPower", label: "bpr", width: 78, numeric: true, format: (r) => oneDecimal(r.buyingPower) },
  { key: "creditToBpr", label: "cr/bpr", width: 72, numeric: true, format: (r) => oneDecimal(r.creditToBpr) },
  { key: "bprToNotional", label: "bpr/ntl", width: 76, numeric: true, format: (r) => oneDecimal(r.bprToNotional) },
  { key: "creditToNotional", label: "cr/ntl", width: 72, numeric: true, format: (r) => oneDecimal(r.creditToNotional) },
  { key: "ivr", label: "ivr", width: 58, numeric: true, format: (r) => oneDecimal(r.ivr) },
  { key: "ivx", label: "ivx", width: 58, numeric: true, format: (r) => oneDecimal(r.ivx) },
];

/** The ticker column is pinned outside the horizontal scroller. */
export const TICKER_COLUMN: Column = {
  key: "ticker",
  label: "ticker",
  width: 74,
  numeric: false,
  format: (r) => r.ticker,
};

export const DEFAULT_SORT: ColumnKey = "creditToBpr";

/** Sorts numerically for numeric columns; nulls always sort last. */
export function sortRows(rows: ScanRow[], key: ColumnKey, ascending: boolean): ScanRow[] {
  const column = [TICKER_COLUMN, ...COLUMNS].find((c) => c.key === key);
  const direction = ascending ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (column?.numeric) return ((av as number) - (bv as number)) * direction;
    return String(av).localeCompare(String(bv)) * direction;
  });
}
