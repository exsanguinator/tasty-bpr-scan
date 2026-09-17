/**
 * Sanity-checks lib/scan.ts against scan-put-bp.py without an Android build.
 * Reads credentials from the repo-root .env and prints the ranked rows as CSV
 * on stdout, with progress and skip reasons on stderr.
 *
 *   npm run scan -- [--bpr-isolated|--bpr-impact] <account-number> "<watchlist>" ...
 */
import { config as loadEnv } from "dotenv";
import fs from "fs";
import path from "path";

import { COLUMNS, TICKER_COLUMN } from "../lib/columns";
import { DEFAULT_BPR_MODE, PHASE_LABELS, runScan, type BprMode } from "../lib/scan";

// Run from mobile/ (npm run scan) or from the repo root; the .env lives at the root.
const envPath = [path.resolve("..", ".env"), path.resolve(".env")].find(fs.existsSync);
if (envPath) loadEnv({ path: envPath, quiet: true });

async function main() {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith("--"));
  const [accountNumber, ...watchlists] = args.filter((a) => !a.startsWith("--"));
  const unknown = flags.filter((f) => f !== "--bpr-isolated" && f !== "--bpr-impact");
  if (!accountNumber || watchlists.length === 0 || unknown.length > 0 || flags.length > 1) {
    console.error(
      'Usage: npm run scan -- [--bpr-isolated|--bpr-impact] <account-number> "<watchlist>" ...',
    );
    process.exit(1);
  }
  const bprMode: BprMode = flags[0] ? (flags[0].slice("--bpr-".length) as BprMode) : DEFAULT_BPR_MODE;

  const result = await runScan({
    accountNumber,
    watchlists,
    bprMode,
    onProgress: ({ phase, done, total }) =>
      process.stderr.write(`\r${PHASE_LABELS[phase]} ${done}/${total}          `),
  });
  process.stderr.write("\n");

  const columns = [TICKER_COLUMN, ...COLUMNS];
  console.log(columns.map((c) => c.label).join(","));
  for (const row of result.rows) {
    console.log(columns.map((c) => c.format(row)).join(","));
  }

  console.error(`\nbpr ${bprMode}: ${result.rows.length} rows, ${result.skipped.length} skipped or noted:`);
  for (const s of result.skipped) console.error(`  ${s.ticker}: ${s.reason}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
