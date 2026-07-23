import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

function truncate(value, max) {
  const s = String(value ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Lets the admin pick which approved-but-not-yet-ingested raw uploads to
// run through the transcode/upload pipeline this run, rather than always
// running the whole approved backlog — mirrors the CSV queue's per-row
// control for link submissions.
export function UploadSelectView({ rows, selectedIds, onToggle, onToggleAll, onRun, onRefresh, onBack }) {
  const [index, setIndex] = useState(0);
  const clampedIndex = rows.length === 0 ? 0 : Math.min(index, rows.length - 1);

  useInput((input, key) => {
    if (key.upArrow || input === "k") {
      setIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow || input === "j") {
      setIndex((i) => Math.min(rows.length - 1, i + 1));
    } else if (input === " ") {
      if (rows[clampedIndex]) onToggle(rows[clampedIndex].id);
    } else if (input === "a") {
      onToggleAll();
    } else if (key.return) {
      onRun();
    } else if (input === "r") {
      onRefresh();
    } else if (input === "q" || key.escape) {
      onBack();
    }
  });

  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(
      Text,
      { bold: true },
      `Approved raw uploads pending ingestion (${rows.length} total, ${selectedIds.size} selected)`,
    ),
    React.createElement(
      Text,
      { dimColor: true },
      "↑/↓ move  space toggle  a select/deselect all  enter ingest selected  r refresh  q back",
    ),
    React.createElement(
      Box,
      { marginTop: 1, flexDirection: "column" },
      rows.length === 0
        ? React.createElement(Text, { dimColor: true }, "No approved raw uploads pending ingestion.")
        : rows.map((row, i) => {
            const isSelected = i === clampedIndex;
            const checked = selectedIds.has(row.id) ? "[x]" : "[ ]";
            const info = `${row.file_size_bytes ?? "?"} bytes, ${row.event_date || "no date"} — ${truncate(row.description, 40)}`;
            return React.createElement(
              Text,
              { key: row.id, color: isSelected ? "cyan" : undefined, inverse: isSelected },
              `${isSelected ? "› " : "  "}${checked} #${row.id}  ${info}`,
            );
          }),
    ),
  );
}
