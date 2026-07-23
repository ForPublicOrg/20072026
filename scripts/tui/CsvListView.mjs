import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

function truncate(value, max) {
  const s = String(value ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export const CSV_FILTER_CYCLE = ["pending", "ignored", "published", "all"];

function matchesFilter(row, filter) {
  if (filter === "all") return true;
  if (filter === "pending") return row.status === "" || row.status === "failed";
  return row.status === filter;
}

// Browses the master CSV (the collect-batch.mjs work queue) so blank/failed
// rows the admin doesn't want retried can be marked "ignored" — the same
// terminal status collect-batch.mjs already treats as permanently skipped —
// without hand-editing the file. Toggling is a plain local-file rewrite (no
// D1/R2 involved), so unlike the request-inbox actions elsewhere in this app
// it doesn't go through a ConfirmDialog: it's low-stakes and reversible by
// pressing the same key again.
export function CsvListView({ rows, filter, onToggleIgnore, onCycleFilter, onOpen, onRefresh, onBack }) {
  const [index, setIndex] = useState(0);

  const filtered = rows.map((row, idx) => ({ row, idx })).filter(({ row }) => matchesFilter(row, filter));
  const clampedIndex = filtered.length === 0 ? 0 : Math.min(index, filtered.length - 1);
  const selected = filtered[clampedIndex];

  useInput((input, key) => {
    if (key.upArrow || input === "k") {
      setIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow || input === "j") {
      setIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (input === "i") {
      if (selected) onToggleIgnore(selected.idx);
    } else if (input === "o") {
      if (selected) onOpen(selected.row.link);
    } else if (input === "f") {
      setIndex(0);
      onCycleFilter();
    } else if (input === "r") {
      onRefresh();
    } else if (input === "q" || key.escape) {
      onBack();
    }
  });

  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(Text, { bold: true }, `Master CSV link queue — filter: ${filter} (${filtered.length})`),
    React.createElement(
      Text,
      { dimColor: true },
      "↑/↓ move  i toggle ignored/pending  o open link  f cycle filter  r refresh  q back",
    ),
    React.createElement(
      Box,
      { marginTop: 1, flexDirection: "column" },
      filtered.length === 0
        ? React.createElement(Text, { dimColor: true }, "No matching rows.")
        : filtered.map(({ row, idx }, i) => {
            const isSelected = i === clampedIndex;
            const status = (row.status || "blank").padEnd(9);
            const notes = truncate(row.notes, 40);
            return React.createElement(
              Text,
              { key: idx, color: isSelected ? "cyan" : undefined, inverse: isSelected },
              `${isSelected ? "› " : "  "}${status}  ${truncate(row.link, 55)}${notes ? `  (${notes})` : ""}`,
            );
          }),
    ),
  );
}
