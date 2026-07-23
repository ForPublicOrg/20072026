import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { shapeVideoRow } from "../lib/admin-resources.mjs";

function truncate(value, max) {
  const s = String(value ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Same columns cmdList already prints for video submissions (via
// shapeVideoRow) — takedown requests get an analogous, terse view since
// they have no "source" concept.
function toDisplayRow(row, type) {
  if (type === "video") {
    const shaped = shapeVideoRow(row);
    return {
      id: shaped.id,
      status: shaped.status,
      summary: truncate(shaped.source, 50),
      created_at: shaped.created_at,
    };
  }
  return {
    id: row.id,
    status: row.status,
    summary: truncate(`[${row.kind}] ${row.entry_ref ? `${row.entry_ref}: ` : ""}${row.message}`, 50),
    created_at: row.created_at,
  };
}

export function ListView({ rows, type, statusFilter, onSelect, onCycleFilter, onRefresh, onBack }) {
  const [index, setIndex] = useState(0);
  const clampedIndex = rows.length === 0 ? 0 : Math.min(index, rows.length - 1);

  useInput((input, key) => {
    if (key.upArrow || input === "k") {
      setIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow || input === "j") {
      setIndex((i) => Math.min(rows.length - 1, i + 1));
    } else if (key.return) {
      if (rows[clampedIndex]) onSelect(rows[clampedIndex]);
    } else if (input === "f") {
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
    React.createElement(
      Text,
      { bold: true },
      `${type === "video" ? "Video submissions" : "Takedown requests"} — filter: ${statusFilter ?? "all"} (${rows.length})`,
    ),
    React.createElement(Text, { dimColor: true }, "↑/↓ move  enter view  f cycle filter  r refresh  q back"),
    React.createElement(Box, { marginTop: 1, flexDirection: "column" },
      rows.length === 0
        ? React.createElement(Text, { dimColor: true }, "No matching requests.")
        : rows.map((row, i) => {
            const display = toDisplayRow(row, type);
            const selected = i === clampedIndex;
            return React.createElement(
              Text,
              { key: display.id, color: selected ? "cyan" : undefined, inverse: selected },
              `${selected ? "› " : "  "}#${display.id}  ${display.status.padEnd(9)}  ${display.summary}  ${display.created_at}`,
            );
          }),
    ),
  );
}
