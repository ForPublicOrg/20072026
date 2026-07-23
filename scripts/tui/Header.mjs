import React from "react";
import { Box, Text } from "ink";

// Always-visible env/auth bar. Environment is fixed for the whole session
// (set from --env at startup, never switchable mid-session) so an admin
// can't accidentally approve a production request while thinking they're
// still on staging.
export function Header({ env, authEmail }) {
  const isProd = env !== "staging";
  return React.createElement(
    Box,
    { justifyContent: "space-between", paddingX: 1, marginBottom: 1 },
    React.createElement(
      Text,
      { bold: true, color: isProd ? "red" : "green", inverse: isProd },
      isProd ? " ENV: PRODUCTION " : " ENV: staging ",
    ),
    React.createElement(
      Text,
      { dimColor: true },
      authEmail ? `wrangler: ✓ ${authEmail}` : "wrangler: not authenticated",
    ),
  );
}
