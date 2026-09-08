import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { fetchAccounts, fetchWatchlists, type Account, type Watchlist } from "../lib/scan";
import {
  THEME_MODES,
  THEME_MODE_LABELS,
  useTheme,
  type Theme,
  type ThemeMode,
} from "../lib/theme";
import type { Settings } from "../lib/storage";

type Props = {
  settings: Settings;
  onChange: (settings: Settings) => void;
};

export function SettingsScreen({ settings, onChange }: Props) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextAccounts, nextWatchlists] = await Promise.all([
        fetchAccounts(),
        fetchWatchlists(),
      ]);
      setAccounts(nextAccounts);
      setWatchlists(nextWatchlists);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggleWatchlist = (name: string) => {
    const selected = new Set(settings.watchlists);
    if (selected.has(name)) selected.delete(name);
    else selected.add(name);
    onChange({ ...settings, watchlists: [...selected].sort() });
  };

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
    >
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {loading && accounts.length === 0 ? (
        <ActivityIndicator style={styles.spinner} color={theme.accent} />
      ) : null}

      {/* Theme sits first: the watchlist list below is long, and burying an
          app-level preference under it would put it several screens down. */}
      <Text style={styles.sectionHeader}>Theme</Text>
      {THEME_MODES.map((mode: ThemeMode) => {
        const selected = mode === settings.themeMode;
        return (
          <Pressable
            key={mode}
            style={styles.row}
            onPress={() => onChange({ ...settings, themeMode: mode })}
          >
            <Text style={[styles.marker, selected && styles.markerSelected]}>
              {selected ? "\u25cf" : "\u25cb"}
            </Text>
            <View style={styles.rowText}>
              <Text style={styles.rowLabel}>{THEME_MODE_LABELS[mode]}</Text>
              {mode === "system" ? (
                <Text style={styles.rowSub}>Follow the device setting</Text>
              ) : null}
            </View>
          </Pressable>
        );
      })}

      <Text style={styles.sectionHeader}>Account</Text>
      {accounts.map((account) => {
        const selected = account.accountNumber === settings.accountNumber;
        return (
          <Pressable
            key={account.accountNumber}
            style={styles.row}
            onPress={() => onChange({ ...settings, accountNumber: account.accountNumber })}
          >
            <Text style={[styles.marker, selected && styles.markerSelected]}>
              {selected ? "●" : "○"}
            </Text>
            <View style={styles.rowText}>
              <Text style={styles.rowLabel}>{account.accountNumber}</Text>
              {account.nickname ? <Text style={styles.rowSub}>{account.nickname}</Text> : null}
            </View>
          </Pressable>
        );
      })}

      <Text style={styles.sectionHeader}>
        Watchlists ({settings.watchlists.length} selected)
      </Text>
      {watchlists.map((watchlist) => {
        const selected = settings.watchlists.includes(watchlist.name);
        return (
          <Pressable
            key={watchlist.name}
            style={styles.row}
            onPress={() => toggleWatchlist(watchlist.name)}
          >
            <Text style={[styles.marker, selected && styles.markerSelected]}>
              {selected ? "☑" : "☐"}
            </Text>
            <View style={styles.rowText}>
              <Text style={styles.rowLabel}>{watchlist.name}</Text>
              <Text style={styles.rowSub}>{watchlist.entryCount} entries</Text>
            </View>
          </Pressable>
        );
      })}
      <View style={styles.footer} />
    </ScrollView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.bg },
    spinner: { marginTop: 24 },
    error: { color: theme.danger, fontSize: 12, padding: 12 },
    sectionHeader: {
      fontSize: 12,
      fontWeight: "700",
      color: theme.muted,
      textTransform: "uppercase",
      letterSpacing: 0.5,
      backgroundColor: theme.surface,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 12,
      paddingVertical: 11,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    marker: { fontSize: 16, color: theme.muted, width: 20, textAlign: "center" },
    markerSelected: { color: theme.accent },
    rowText: { flex: 1 },
    rowLabel: { fontSize: 14, color: theme.text },
    rowSub: { fontSize: 11, color: theme.muted, marginTop: 2 },
    footer: { height: 32 },
  });
