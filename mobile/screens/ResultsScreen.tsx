import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { ResultsTable } from "../components/ResultsTable";
import { PHASE_LABELS, isAbortError, runScan, type Progress, type ScanResult } from "../lib/scan";
import { loadLastResult, saveLastResult, type Settings } from "../lib/storage";
import { useTheme, type Theme } from "../lib/theme";

function formatRanAt(ranAt: number): string {
  if (!ranAt) return "never";
  return new Date(ranAt).toLocaleString();
}

export function ResultsScreen({ settings }: { settings: Settings }) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    loadLastResult().then((cached) => {
      if (cached) setResult(cached);
    });
    return () => abortRef.current?.abort();
  }, []);

  const running = progress !== null;
  const canRun = Boolean(settings.accountNumber) && settings.watchlists.length > 0;

  async function refresh() {
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setProgress({ phase: "watchlists", done: 0, total: 1 });
    try {
      const next = await runScan({
        accountNumber: settings.accountNumber!,
        watchlists: settings.watchlists,
        onProgress: setProgress,
        signal: controller.signal,
      });
      setResult(next);
      await saveLastResult(next);
    } catch (err) {
      if (!isAbortError(err)) setError(err instanceof Error ? err.message : String(err));
    } finally {
      abortRef.current = null;
      setProgress(null);
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <Pressable
          onPress={running ? () => abortRef.current?.abort() : refresh}
          disabled={!running && !canRun}
          style={[
            styles.button,
            running && styles.buttonCancel,
            !running && !canRun && styles.buttonDisabled,
          ]}
        >
          <Text style={styles.buttonText}>{running ? "Cancel" : "Refresh"}</Text>
        </Pressable>
        <View style={styles.status}>
          {running ? (
            <View style={styles.progressRow}>
              <ActivityIndicator size="small" color={theme.accent} />
              <Text style={styles.statusText}>
                {PHASE_LABELS[progress.phase]} {progress.done}/{progress.total}
              </Text>
            </View>
          ) : (
            <Text style={styles.statusText}>
              {result
                ? `${result.rows.length} rows · ${formatRanAt(result.ranAt)}`
                : canRun
                  ? "No results yet."
                  : "Pick an account and at least one watchlist in Settings."}
            </Text>
          )}
        </View>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {/* The table scrolls itself so its header row can stay pinned, so it takes the
          free space and the skipped list sits below it rather than scrolling with it. */}
      <View style={styles.body}>
        {result && result.rows.length > 0 ? <ResultsTable rows={result.rows} /> : null}
      </View>

      {result && result.skipped.length > 0 ? (
        <View style={styles.skipped}>
          <Pressable onPress={() => setShowSkipped((prev) => !prev)}>
            <Text style={styles.skippedHeader}>
              {showSkipped ? "▼" : "▶"} Skipped ({result.skipped.length})
            </Text>
          </Pressable>
          {showSkipped ? (
            <ScrollView style={styles.skippedList}>
              {result.skipped.map((s, i) => (
                <Text key={`${s.ticker}-${i}`} style={styles.skippedRow}>
                  {s.ticker}: {s.reason}
                </Text>
              ))}
            </ScrollView>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.bg },
    toolbar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    button: {
      backgroundColor: theme.accentBg,
      paddingHorizontal: 18,
      paddingVertical: 9,
      borderRadius: 6,
    },
    buttonCancel: { backgroundColor: theme.dangerBg },
    buttonDisabled: { backgroundColor: theme.muted, opacity: 0.5 },
    buttonText: { color: theme.onAccent, fontWeight: "600", fontSize: 14 },
    status: { flex: 1 },
    progressRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    statusText: { fontSize: 12, color: theme.muted },
    error: {
      color: theme.danger,
      fontSize: 12,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    body: { flex: 1 },
    skipped: {
      paddingHorizontal: 12,
      paddingBottom: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    /** Capped so expanding a long skip list cannot crowd out the table. */
    skippedList: { maxHeight: 180 },
    skippedHeader: { fontSize: 13, fontWeight: "600", color: theme.muted, paddingVertical: 6 },
    skippedRow: { fontSize: 11, color: theme.muted, paddingVertical: 2 },
  });
