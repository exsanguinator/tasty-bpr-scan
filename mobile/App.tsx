import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

import { loadConfig } from "./lib/config";
import { ThemeProvider, useTheme, type Theme } from "./lib/theme";
import { ResultsScreen } from "./screens/ResultsScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { loadSettings, saveSettings, type Settings } from "./lib/storage";

type Tab = "results" | "settings";

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);

  const updateSettings = (next: Settings) => {
    setSettings(next);
    saveSettings(next);
  };

  return (
    <SafeAreaProvider>
      {/* Falls back to "system" until the stored preference has loaded. */}
      <ThemeProvider mode={settings?.themeMode ?? "system"}>
        <AppContent settings={settings} onChangeSettings={updateSettings} />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

type AppContentProps = {
  settings: Settings | null;
  onChangeSettings: (settings: Settings) => void;
};

function AppContent({ settings, onChangeSettings }: AppContentProps) {
  const [tab, setTab] = useState<Tab>("results");
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const configResult = loadConfig();

  if ("errors" in configResult) {
    return (
      <SafeAreaView style={styles.container} edges={["top", "bottom", "left", "right"]}>
        <StatusBar style={theme.dark ? "light" : "dark"} />
        <View style={styles.blocking}>
          <Text style={styles.blockingTitle}>Configuration problem</Text>
          {configResult.errors.map((message) => (
            <Text key={message} style={styles.blockingBody}>
              {message}
            </Text>
          ))}
          <Text style={styles.blockingHint}>
            Fix the repo-root .env and rebuild — credentials are baked in at build time.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom", "left", "right"]}>
      <StatusBar style={theme.dark ? "light" : "dark"} />
      <View style={styles.tabs}>
        {(["results", "settings"] as Tab[]).map((name) => (
          <Pressable
            key={name}
            style={[styles.tab, tab === name && styles.tabActive]}
            onPress={() => setTab(name)}
          >
            <Text style={[styles.tabText, tab === name && styles.tabTextActive]}>
              {name === "results" ? "Results" : "Settings"}
            </Text>
          </Pressable>
        ))}
      </View>
      {settings === null ? null : tab === "results" ? (
        <ResultsScreen settings={settings} />
      ) : (
        <SettingsScreen settings={settings} onChange={onChangeSettings} />
      )}
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.bg },
    tabs: {
      flexDirection: "row",
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      backgroundColor: theme.surface,
    },
    tab: {
      flex: 1,
      paddingVertical: 12,
      alignItems: "center",
      borderBottomWidth: 2,
      borderColor: "transparent",
    },
    tabActive: { borderColor: theme.accent },
    tabText: { fontSize: 14, fontWeight: "600", color: theme.muted },
    tabTextActive: { color: theme.accent },
    blocking: { padding: 24, gap: 12 },
    blockingTitle: { fontSize: 18, fontWeight: "700", color: theme.danger },
    blockingBody: { fontSize: 14, color: theme.text, lineHeight: 20 },
    blockingHint: { fontSize: 12, color: theme.muted, marginTop: 8 },
  });
