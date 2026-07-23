#!/usr/bin/env node
// Cloudflare auth check/login for admin-tui.mjs. No existing script in this
// repo has ever needed to detect wrangler's auth state programmatically
// (scripts/admin-requests.mjs just lets a downstream `wrangler d1 execute`
// fail with wrangler's own error) — this is the first.
//
// `wrangler whoami --json` is the reliable signal here: confirmed by reading
// wrangler's own source (node_modules/wrangler/wrangler-dist/cli.js) that
// --json "exits with a non-zero status if not authenticated" and prints
// `{ loggedIn: true, email, accounts: [...] }` on success — no need to parse
// the human-readable banner text.

import { spawnSync } from "node:child_process";

export function checkAuth() {
  const result = spawnSync("npx", ["wrangler", "whoami", "--json"], { encoding: "utf8" });

  if (result.status !== 0) {
    return { authenticated: false, email: null };
  }

  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed.loggedIn === true) {
      return { authenticated: true, email: parsed.email ?? null };
    }
  } catch {
    // Fall through to fail-closed below.
  }

  // Anything ambiguous (unparseable output, unexpected shape) is treated as
  // not authenticated — worse case is an unnecessary login prompt, not a
  // silent false-positive that lets a later D1/R2 call fail confusingly.
  return { authenticated: false, email: null };
}

// Runs `wrangler login` with the terminal fully inherited so its printed
// URL, "opening browser..." message, and the OAuth flow itself all work
// exactly as they do when a human runs it directly. Must only be called
// before Ink has mounted (or after it's been unmounted) — this needs the
// real terminal, not Ink's raw-mode stdin.
export function login() {
  spawnSync("npx", ["wrangler", "login"], { stdio: "inherit" });
  return checkAuth();
}
