/**
 * Sanity-checks lib/scan.ts against scan-put-bp.py without an Android build.
 * Reads credentials from the repo-root .env and prints the ranked rows as CSV
 * on stdout, with progress and skip reasons on stderr.
 *
 *   npm run scan -- <account-number> "<watchlist>" ["<watchlist>" ...]
 */
import { config as loadEnv } from "dotenv";
import fs from "fs";
import path from "path";

import { COLUMNS, TICKER_COLUMN } from "../lib/columns";
import { PHASE_LABELS, runScan } from "../lib/scan";

// Run from mobile/ (npm run scan) or from the repo root; the .env lives at the root.
const envPath = [path.resolve("..", ".env"), path.resolve(".env")].find(fs.existsSync);
if (envPath) loadEnv({ path: envPath, quiet: true });

async function main() {
  const [accountNumber, ...watchlists] = process.argv.slice(2);
  if (!accountNumber || watchlists.length === 0) {
    console.error('Usage: npm run scan -- <account-number> "<watchlist>" ...');
    process.exit(1);
  }

  const result = await runScan({
    accountNumber,
    watchlists,
    onProgress: ({ phase, done, total }) =>
      process.stderr.write(`\r${PHASE_LABELS[phase]} ${done}/${total}          `),
  });
  process.stderr.write("\n");

  const columns = [TICKER_COLUMN, ...COLUMNS];
  console.log(columns.map((c) => c.label).join(","));
  for (const row of result.rows) {
    console.log(columns.map((c) => c.format(row)).join(","));
  }

  console.error(`\n${result.rows.length} rows, ${result.skipped.length} skipped:`);
  for (const s of result.skipped) console.error(`  ${s.ticker}: ${s.reason}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
