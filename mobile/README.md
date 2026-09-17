# Put BP Scan (Android)

A standalone Expo / React Native port of the repo's `scan-put-bp.py`. Ranks short-put
candidates from your Tastytrade watchlists by credit-to-buying-power efficiency and
renders them in a sortable on-screen table. No backend — the phone talks to the
Tastytrade API directly.

## Credentials

Credentials are **baked into the build** at compile time from the repo-root `.env`
(`TASTY_ENV`, `TASTY_CLIENT_SECRET`, `TASTY_REFRESH_TOKEN`), read by `app.config.ts`
and surfaced through `expo-constants`. `TASTY_ENV` must be `prod`: the scan depends on
`/market-data/by-type`, which cert does not serve.

> Anyone with the APK can extract the client secret and refresh token. Sideload it to
> your own phones only — do not share the built APK. Rotating the refresh token means
> editing `.env` and rebuilding.

## Verifying the scan logic without a build

`lib/scan.ts` is a straight port of `scan-put-bp.py` and can be run under Node:

```bash
npm install
npm run scan -- [--bpr-isolated|--bpr-impact] <account-number> "My Watchlist 1" "My Watchlist 2"
```

It prints the same CSV columns to stdout and skip reasons to stderr, so the output can
be diffed against `TASTY_ENV=prod python ../scan-put-bp.py` run with the same `--bpr-*`
flag (both default to `--bpr-isolated`).

```bash
npm run typecheck
```

## Building an APK

The Android toolchain is not installed by default on macOS. One-time setup:

```bash
brew install --cask temurin@17
brew install --cask android-commandlinetools
sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$PATH:$ANDROID_HOME/platform-tools"
```

Then, from this directory:

```bash
npx expo prebuild -p android            # generates android/ (gitignored)
npx expo run:android --variant release  # builds and installs over USB
```

The APK lands at `android/app/build/outputs/apk/release/app-release.apk`; copy that file
to any other phone to sideload it.

For iterating on the UI without a full build, `npx expo start` plus the Expo Go app works,
but that needs this Mac serving the bundle.

## Layout

| Path | Purpose |
|---|---|
| `app.config.ts` | Loads `../.env`, injects credentials into `expo.extra` |
| `lib/config.ts` | Reads baked credentials; validates env is `prod` |
| `lib/tastyClient.ts` | OAuth refresh-token flow, `get()` / `postDryRun()` |
| `lib/scan.ts` | Port of `scan-put-bp.py`, plus account/watchlist fetches |
| `lib/skew.ts` | 25-delta skew: strike selection, vol inversion, interpolation |
| `lib/blackscholes.ts` | Normal CDF/PDF/quantile, Brent root-finder, Black-Scholes |
| `lib/columns.ts` | Column definitions, formatters, numeric sort |
| `lib/storage.ts` | AsyncStorage: settings (account, watchlists, theme, BPR) and last scan result |
| `lib/theme.ts` | Light/dark palettes, `ThemeProvider`, `useTheme()` |
| `components/ResultsTable.tsx` | Sortable table, pinned ticker column and header row |
| `screens/` | Results and Settings screens |
| `scripts/scan-cli.ts` | Runs the scan under Node for verification |

## Behavioral differences from `scan-put-bp.py`

- The per-ticker option-chain fetches and order dry-runs run **5 at a time** instead of
  sequentially, and can be cancelled mid-scan. The option quotes and the re-fetched spot
  run as one parallel phase rather than two sequential ones.
- `skew` is computed without scipy: `lib/blackscholes.ts` supplies the normal
  distribution and a Brent root-finder in TypeScript. Cross-checked against
  `scipy.stats.norm` / `scipy.optimize.brentq` on synthetic smiles, and against a full
  production watchlist run of `scan-put-bp.py`, where all 151 rows' `skew` matched to
  the printed decimal.
- Rows hold raw numbers and are formatted at render time, so table columns sort
  numerically rather than lexically.
- Cells are colored as in `scan-put-bp.py`'s HTML output (the CSV is plain text):
  `chg%` and `skew` green when positive and red when negative; `52wk %` red below 50
  and green above; `ivr` green above 50; `bpr` red at or below zero. Ties and blanks keep
  the default text color, and the comparison uses the displayed value (so `50.0` or
  `-0.0` stays uncolored), as the HTML does.
- The **BPR** setting picks which dry-run field becomes `bpr`, like the Python script's
  `--bpr-isolated` (default, `isolated-order-margin-requirement`) and `--bpr-impact`
  (`change-in-buying-power`, which already nets out the credit received). The status line
  shows the mode the displayed result was scanned with, since changing the setting only
  takes effect on the next Refresh. As in the Python script, a ticker whose dry-run fails
  or lacks that field keeps its row with `bpr`, `cr/bpr` and `bpr/ntl` blank, and one
  whose `bpr` is `<= 0` shows it with `cr/bpr` and `bpr/ntl` blank; both sort after the
  ranked rows.
- Skipped tickers and their reasons appear in a collapsible "Skipped" section instead of
  going to stderr. The `skew:` and `bpr:` entries there are not skips: the ticker still
  has a row, and the entry explains the blank `skew` cell or the blank or `<= 0`
  buying-power cells. Those reasons are
  worded more tersely than the Python script's stderr line (`no 25d call vol (2 strikes,
  δ 0.19-0.40, seed 0.287)`), because the list renders each entry on a single line and a
  longer one is clipped at the screen edge rather than wrapped.
- Settings (account, watchlists, theme, BPR) and the last result are persisted on-device; there is
  no `margin-scan-config.json`. The first-launch defaults are the placeholders from
  `margin-scan-config.json.example`, so pick your account and watchlists in Settings before
  the first scan.
- No CSV or HTML output.
