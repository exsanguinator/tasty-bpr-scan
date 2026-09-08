import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import {
  COLUMNS,
  DEFAULT_SORT,
  TICKER_COLUMN,
  sortRows,
  type Column,
  type ColumnKey,
  type ScanRow,
} from "../lib/columns";
import { useTheme, type Theme } from "../lib/theme";

const ROW_HEIGHT = 34;

type HeaderCellProps = {
  column: Column;
  sortKey: ColumnKey;
  ascending: boolean;
  onPress: (key: ColumnKey) => void;
};

function HeaderCell({ column, sortKey, ascending, onPress }: HeaderCellProps) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const active = column.key === sortKey;
  return (
    <Pressable
      onPress={() => onPress(column.key)}
      style={[styles.cell, styles.headerCell, { width: column.width }]}
    >
      {/* The arrow sits outside the truncating label, otherwise a narrow column
          ellipsizes the indicator away instead of the label text. */}
      <View style={[styles.headerInner, column.numeric && styles.headerInnerNumeric]}>
        <Text
          numberOfLines={1}
          style={[styles.headerText, active && styles.headerTextActive]}
        >
          {column.label}
        </Text>
        {active ? (
          <Text style={[styles.headerText, styles.headerTextActive, styles.headerArrow]}>
            {ascending ? "▲" : "▼"}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

export function ResultsTable({ rows }: { rows: ScanRow[] }) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [sortKey, setSortKey] = useState<ColumnKey>(DEFAULT_SORT);
  const [ascending, setAscending] = useState(false);

  const sorted = useMemo(() => sortRows(rows, sortKey, ascending), [rows, sortKey, ascending]);

  // First press on a new column sorts descending (highest first, which is what
  // every ratio column here is read for); pressing the active column flips it.
  const handleSort = (key: ColumnKey) => {
    if (key === sortKey) {
      setAscending((prev) => !prev);
    } else {
      setSortKey(key);
      setAscending(false);
    }
  };

  return (
    <View style={styles.container}>
      {/* Pinned ticker column: 11 more columns will not fit a phone, so the rest scroll. */}
      <View>
        <HeaderCell
          column={TICKER_COLUMN}
          sortKey={sortKey}
          ascending={ascending}
          onPress={handleSort}
        />
        {sorted.map((item, index) => (
          <View
            key={item.putSymbol}
            style={[styles.row, index % 2 === 1 && styles.stripe]}
          >
            <View style={[styles.cell, { width: TICKER_COLUMN.width }]}>
              <Text numberOfLines={1} style={styles.tickerText}>
                {item.ticker}
              </Text>
            </View>
          </View>
        ))}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator>
        <View>
          <View style={styles.row}>
            {COLUMNS.map((column) => (
              <HeaderCell
                key={column.key}
                column={column}
                sortKey={sortKey}
                ascending={ascending}
                onPress={handleSort}
              />
            ))}
          </View>
          {sorted.map((item, index) => (
            <View
              key={item.putSymbol}
              style={[styles.row, index % 2 === 1 && styles.stripe]}
            >
              {COLUMNS.map((column) => (
                <View key={column.key} style={[styles.cell, { width: column.width }]}>
                  <Text numberOfLines={1} style={[styles.text, column.numeric && styles.numeric]}>
                    {column.format(item)}
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: { flexDirection: "row" },
    row: { flexDirection: "row", height: ROW_HEIGHT, alignItems: "center" },
    stripe: { backgroundColor: theme.stripe },
    cell: {
      height: ROW_HEIGHT,
      justifyContent: "center",
      paddingHorizontal: 6,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    headerCell: { backgroundColor: theme.headerBg },
    headerInner: { flexDirection: "row", alignItems: "center" },
    headerInnerNumeric: { justifyContent: "flex-end" },
    headerArrow: { fontSize: 9, marginLeft: 2 },
    headerText: { fontSize: 12, fontWeight: "600", color: theme.muted },
    headerTextActive: { color: theme.accent },
    text: { fontSize: 13, color: theme.text },
    tickerText: { fontSize: 13, fontWeight: "600", color: theme.text },
    numeric: { textAlign: "right" },
  });
