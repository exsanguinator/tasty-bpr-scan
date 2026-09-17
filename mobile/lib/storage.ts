import AsyncStorage from "@react-native-async-storage/async-storage";

import type { ScanRow } from "./columns";
import { BPR_MODES, DEFAULT_BPR_MODE, type BprMode, type ScanResult, type Skipped } from "./scan";
import { THEME_MODES, type ThemeMode } from "./theme";

const SETTINGS_KEY = "settings.v1";
const RESULT_KEY = "lastResult.v1";

export type Settings = {
  accountNumber: string | null;
  watchlists: string[];
  themeMode: ThemeMode;
  /** Which dry-run field becomes bpr; see BPR_MODES in scan.ts. */
  bprMode: BprMode;
};

/**
 * Placeholders matching margin-scan-config.json.example -- no real account or
 * watchlist names live in the repo. Pick both in Settings on first launch.
 */
export const DEFAULT_SETTINGS: Settings = {
  themeMode: "system",
  bprMode: DEFAULT_BPR_MODE,
  accountNumber: "XXXXXXXXX",
  watchlists: ["My Watchlist 1", "My Watchlist 2"],
};

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      accountNumber: parsed.accountNumber ?? null,
      watchlists: parsed.watchlists ?? [],
      // Guard against a settings blob written before themeMode existed.
      themeMode:
        parsed.themeMode && THEME_MODES.includes(parsed.themeMode)
          ? parsed.themeMode
          : "system",
      // Likewise for a blob written before bprMode existed.
      bprMode: parsed.bprMode && parsed.bprMode in BPR_MODES ? parsed.bprMode : DEFAULT_BPR_MODE,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export async function loadLastResult(): Promise<ScanResult | null> {
  try {
    const raw = await AsyncStorage.getItem(RESULT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      rows?: ScanRow[];
      skipped?: Skipped[];
      ranAt?: number;
      bprMode?: BprMode;
    };
    if (!parsed.rows) return null;
    return {
      rows: parsed.rows,
      skipped: parsed.skipped ?? [],
      ranAt: parsed.ranAt ?? 0,
      bprMode: parsed.bprMode,
    };
  } catch {
    return null;
  }
}

export async function saveLastResult(result: ScanResult): Promise<void> {
  await AsyncStorage.setItem(RESULT_KEY, JSON.stringify(result));
}
