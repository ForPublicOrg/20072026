#!/usr/bin/env node
// Shared Cloudflare D1/R2 helpers for the admin request-inbox tooling
// (scripts/admin-requests.mjs, scripts/admin-tui.mjs). Every wrangler
// invocation for reviewing/updating the private takedown/video-submission
// inboxes lives here so both entry points share exactly one implementation.
//
// d1Execute/r2Get/r2Put throw plain Errors on failure rather than calling
// process.exit: admin-requests.mjs (a one-shot CLI) catches at its top level
// and exits; admin-tui.mjs (a long-lived interactive session) catches per
// action and shows an inline error instead of killing the whole session.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsvRows, writeCsvRows } from "../collect-batch.mjs";

export { parseCsvRows, writeCsvRows };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "../..");
export const MASTER_CSV = path.join(ROOT, "20072026 - Sheet1.csv");

export const STATUSES = new Set(["new", "reviewing", "approved", "rejected", "done"]);

// Always unsuffixed — the one R2 bucket shared between staging and
// production (reference media served at media.20072026.com).
export const MEDIA_BUCKET = "blackdays-media";

export const RESOURCES = {
  takedown: {
    table: "takedown_requests",
    database: (env) => (env === "staging" ? "blackdays-takedowns-staging" : "blackdays-takedowns"),
  },
  video: {
    table: "video_submissions",
    database: (env) =>
      env === "staging" ? "blackdays-video-submissions-staging" : "blackdays-video-submissions",
  },
};

export const UPLOAD_BUCKET = (env) => (env === "staging" ? "blackdays-uploads-staging" : "blackdays-uploads");

export function requireResource(type) {
  const resource = RESOURCES[type];
  if (!resource) throw new Error(`--type must be one of: ${Object.keys(RESOURCES).join(", ")}`);
  return resource;
}

export function d1Execute(database, sql) {
  const result = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", database, "--remote", "--json", "--command", sql],
    { encoding: "utf8" },
  );

  if (result.error) {
    throw new Error(`Could not run wrangler: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "wrangler d1 execute failed.");
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Could not parse wrangler's output as JSON:\n${result.stdout}`);
  }
  return parsed[0]?.results ?? [];
}

// `quiet: true` captures stdout/stderr instead of inheriting the terminal —
// used by admin-tui.mjs, which owns the terminal via Ink and can't safely
// let a child process write to it mid-render. admin-requests.mjs (the CLI)
// never passes this, so its live download/upload progress is unchanged.
export function r2Get(bucket, key, outPath, { quiet = false } = {}) {
  const result = spawnSync(
    "npx",
    ["wrangler", "r2", "object", "get", `${bucket}/${key}`, "--file", outPath, "--remote"],
    quiet ? { encoding: "utf8" } : { stdio: "inherit" },
  );
  if (result.error) {
    throw new Error(`Could not run wrangler: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      quiet
        ? result.stderr || result.stdout || "wrangler r2 object get failed."
        : "wrangler r2 object get failed — see output above.",
    );
  }
}

export function r2Put(bucket, key, filePath, { quiet = false } = {}) {
  const result = spawnSync(
    "npx",
    ["wrangler", "r2", "object", "put", `${bucket}/${key}`, "--file", filePath, "--remote"],
    quiet ? { encoding: "utf8" } : { stdio: "inherit" },
  );
  if (result.error) {
    throw new Error(`Could not run wrangler: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      quiet
        ? result.stderr || result.stdout || "wrangler r2 object put failed."
        : "wrangler r2 object put failed — see output above.",
    );
  }
}

// Collapse a raw video_submissions row's type-specific columns into one
// human-readable "source" column — shared by admin-requests.mjs's `list`
// command and admin-tui.mjs's list view so both render submissions the same
// way.
export function shapeVideoRow(row) {
  return {
    id: row.id,
    status: row.status,
    source:
      row.submission_type === "upload"
        ? `upload (${row.file_size_bytes ?? "?"} bytes, ${row.r2_key ?? "not yet uploaded"})`
        : row.url,
    event_date: row.event_date,
    description: row.description,
    contact: row.contact,
    created_at: row.created_at,
  };
}

// Approving a url-type video submission means queuing its link for the next
// collect-batch.mjs run — append it to the same master CSV that script reads
// (skipping if it's already there). Shared by admin-requests.mjs's `update`
// command and admin-tui.mjs so there is exactly one implementation.
export function appendUrlSubmissionToCsv(row, id) {
  if (!row.url) return { appended: false, reason: "no-url" };
  const csvRows = parseCsvRows(MASTER_CSV);
  if (csvRows.some((r) => r.link === row.url)) {
    return { appended: false, reason: "already-present" };
  }
  csvRows.push({
    link: row.url,
    status: "",
    videoId: "",
    notes: `submitted via web form (submission #${id})`,
  });
  writeCsvRows(MASTER_CSV, csvRows);
  return { appended: true };
}
