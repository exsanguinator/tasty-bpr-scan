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
npm run scan -- <account-number> "My Watchlist 1" "My Watchlist 2"
```

It prints the same CSV columns to stdout and skip reasons to stderr, so the output can
be diffed against `TASTY_ENV=prod python ../scan-put-bp.py`.

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
| `lib/columns.ts` | Column definitions, formatters, numeric sort |
| `lib/storage.ts` | AsyncStorage: settings and last scan result |
| `lib/theme.ts` | Light/dark palettes, `ThemeProvider`, `useTheme()` |
| `components/ResultsTable.tsx` | Sortable table, pinned ticker column and header row |
| `screens/` | Results and Settings screens |
| `scripts/scan-cli.ts` | Runs the scan under Node for verification |

## Behavioral differences from `scan-put-bp.py`

- The per-ticker option-chain fetches and order dry-runs run **5 at a time** instead of
  sequentially, and can be cancelled mid-scan.
- Rows hold raw numbers and are formatted at render time, so table columns sort
  numerically rather than lexically.
- `chg%` is colored green when positive and red when negative (zero and blanks keep the
  default text color); the CSV from `scan-put-bp.py` is plain text.
- Skipped tickers and their reasons appear in a collapsible "Skipped" section instead of
  going to stderr.
- Settings (account, watchlists, theme) and the last result are persisted on-device; there is
  no `margin-scan-config.json`. The first-launch defaults are the placeholders from
  `margin-scan-config.json.example`, so pick your account and watchlists in Settings before
  the first scan.
- No CSV or HTML output.
