#!/usr/bin/env node
// Local scratch space for admin-tui.mjs: downloaded raw uploads (for review
// and as ingestion input) and their transcoded/thumbnail output, keyed by
// submission/video id. Lives entirely outside the repo tree (OS tmp dir) —
// nothing here is ever committed or served.

import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const CACHE_DIR = path.join(os.tmpdir(), "blackdays-admin-tui-cache");

export function getCacheDir() {
  mkdirSync(CACHE_DIR, { recursive: true });
  return CACHE_DIR;
}
