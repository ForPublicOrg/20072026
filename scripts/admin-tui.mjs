#!/usr/bin/env node
// Interactive terminal UI for reviewing the two private request inboxes
// (video submissions, takedown/correction requests): list, view, approve,
// reject, open the actual content for review (raw uploads in the OS video
// player, link submissions in the browser), and — for approved video
// submissions — trigger ingestion (the existing collect-batch.mjs pipeline
// for links, a new transcode/thumbnail/R2-upload pipeline for raw uploads).
//
// Usage: node scripts/admin-tui.mjs [--env staging]
//
// For a scriptable, non-interactive alternative (and the one this tool
// shares all its Cloudflare wrangler logic with), see admin-requests.mjs.
//
// Auth: checks `wrangler whoami` before drawing anything; if not
// authenticated, runs `wrangler login` (opens a browser) and re-checks.
// This happens entirely before Ink mounts — wrangler login needs the real
// terminal, which Ink's raw-mode stdin would otherwise be holding.

import React from "react";
import { render } from "ink";
import { checkAuth, login } from "./lib/wrangler-auth.mjs";
import { App } from "./tui/App.mjs";
import { suspendInk } from "./tui/suspend.mjs";

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    flags[arg.slice(2)] = argv[i + 1];
    i++;
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));
const env = flags.env === "staging" ? "staging" : undefined;

let auth = checkAuth();
if (!auth.authenticated) {
  console.log("Not authenticated with Cloudflare — running `wrangler login`...\n");
  auth = login();
  if (!auth.authenticated) {
    console.error("\nStill not authenticated after `wrangler login`. Run it yourself and try again.");
    process.exit(1);
  }
}

let instance = null;
let resumeState = null;

function renderApp() {
  instance = render(
    React.createElement(App, {
      env,
      authEmail: auth.email,
      resumeState,
      onSuspend: (nextResumeState, fn) => {
        resumeState = nextResumeState;
        suspendInk(instance, fn);
        renderApp();
      },
    }),
  );
}

renderApp();
