import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";
import { useColorScheme } from "react-native";

export type ThemeMode = "system" | "light" | "dark";
export const THEME_MODES: ThemeMode[] = ["system", "light", "dark"];

export const THEME_MODE_LABELS: Record<ThemeMode, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

export type Theme = {
  /** True when the resolved scheme is dark; drives the status bar style. */
  dark: boolean;
  bg: string;
  surface: string;
  border: string;
  headerBg: string;
  stripe: string;
  text: string;
  muted: string;
  /** Accent for text, borders and spinners. */
  accent: string;
  /** Accent as a filled button background; pair with `onAccent`. */
  accentBg: string;
  onAccent: string;
  /** Danger for text. */
  danger: string;
  /** Danger as a filled button background; pair with `onAccent`. */
  dangerBg: string;
  /** Sign colors for signed numeric cells (chg%); zero stays the default text color. */
  positive: string;
  negative: string;
};

export const lightTheme: Theme = {
  dark: false,
  bg: "#ffffff",
  surface: "#f4f5f7",
  border: "#d8dbe0",
  headerBg: "#eceef1",
  stripe: "#f8f9fa",
  text: "#1a1c1e",
  muted: "#6b7280",
  accent: "#1d4ed8",
  accentBg: "#1d4ed8",
  onAccent: "#ffffff",
  danger: "#b91c1c",
  dangerBg: "#b91c1c",
  positive: "#15803d",
  negative: "#b91c1c",
};

// Accent and danger split into text vs. background variants: the light-theme blue is
// too dark to read against a dark surface, while the lightened text blue is too weak
// to carry white button text.
export const darkTheme: Theme = {
  dark: true,
  bg: "#121417",
  surface: "#1b1e23",
  border: "#2c3138",
  headerBg: "#21262c",
  stripe: "#171a1e",
  text: "#e7e9ec",
  muted: "#9aa3ad",
  accent: "#7aa8ff",
  accentBg: "#2f6fed",
  onAccent: "#ffffff",
  danger: "#ff9a90",
  dangerBg: "#c1372b",
  positive: "#5fd894",
  negative: "#ff9a90",
};

const ThemeContext = createContext<Theme>(lightTheme);

export function ThemeProvider({ mode, children }: { mode: ThemeMode; children: ReactNode }) {
  const systemScheme = useColorScheme();
  const theme = useMemo(() => {
    const resolved = mode === "system" ? (systemScheme ?? "light") : mode;
    return resolved === "dark" ? darkTheme : lightTheme;
  }, [mode, systemScheme]);
  return createElement(ThemeContext.Provider, { value: theme }, children);
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
