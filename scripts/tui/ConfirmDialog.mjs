import React from "react";
import { Box, Text, useInput } from "ink";

// Generic y/n confirmation, used before every state-mutating action
// (approve/reject/ingest) — always echoes exactly what will happen so
// nothing mutates the private inboxes or the repo by surprise.
export function ConfirmDialog({ title, message, onYes, onNo }) {
  useInput((input, key) => {
    if (input === "y" || input === "Y") onYes();
    else if (input === "n" || input === "N" || key.escape) onNo();
  });

  return React.createElement(
    Box,
    { flexDirection: "column", borderStyle: "round", borderColor: "yellow", padding: 1 },
    React.createElement(Text, { bold: true, color: "yellow" }, title),
    React.createElement(Text, null, message),
    React.createElement(Box, { marginTop: 1 }, React.createElement(Text, { dimColor: true }, "[y] yes   [n] no")),
  );
}
