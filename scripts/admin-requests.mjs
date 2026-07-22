#!/usr/bin/env node
// Admin tooling for the two private request inboxes this site collects:
// takedown/correction requests (takedown_requests) and "Submit a video"
// requests (video_submissions, either a link or a raw upload — see
// src/worker.ts and migrations/video-submissions/0001_video_submissions.sql).
//
// Usage:
//   node scripts/admin-requests.mjs list   --type takedown|video [--status <s>] [--format table|csv|json] [--env staging]
//   node scripts/admin-requests.mjs update --type takedown|video --id <n> --status <new|reviewing|approved|rejected|done> [--env staging]
//   node scripts/admin-requests.mjs download --id <n> --out <path> [--env staging]   (video uploads only)
//
// Auth: every command shells out to `wrangler` (d1 execute / r2 object get),
// relying entirely on the operator's own `wrangler login` session — the same
// mechanism already documented for takedowns in migrations/0001_takedown_requests.sql
// and docs/content-pipeline.md. This script never reads, stores, or prompts
// for a token/password; if wrangler isn't authenticated it'll fail with its
// own "please run wrangler login" message, which this script just surfaces.
// Nothing secret is ever written to the repo, an env file, or shell history.
//
// --env staging targets the isolated staging databases/bucket (see
// .claude/skills/deploy/SKILL.md) so a PR's test data can be reviewed without
// touching production.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsvRows, writeCsvRows } from "./collect-batch.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const MASTER_CSV = path.join(ROOT, "20072026 - Sheet1.csv");

const STATUSES = new Set(["new", "reviewing", "approved", "rejected", "done"]);

const RESOURCES = {
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

const UPLOAD_BUCKET = (env) => (env === "staging" ? "blackdays-uploads-staging" : "blackdays-uploads");

// ---------------------------------------------------------------------------
// Arg parsing — no dependency, this project's scripts don't use one.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const command = argv[0];
  const flags = {};
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    flags[key] = value;
    i++;
  }
  return { command, flags };
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// wrangler CLI wrappers
// ---------------------------------------------------------------------------

function d1Execute(database, sql) {
  const result = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", database, "--remote", "--json", "--command", sql],
    { encoding: "utf8" },
  );

  if (result.error) {
    fail(`Could not run wrangler: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(result.stderr || result.stdout || "wrangler d1 execute failed.");
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    fail(`Could not parse wrangler's output as JSON:\n${result.stdout}`);
  }
  return parsed[0]?.results ?? [];
}

function r2Get(bucket, key, outPath) {
  const result = spawnSync(
    "npx",
    ["wrangler", "r2", "object", "get", `${bucket}/${key}`, "--file", outPath, "--remote"],
    { stdio: "inherit" },
  );
  if (result.error) {
    fail(`Could not run wrangler: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail("wrangler r2 object get failed — see output above.");
  }
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function printTable(rows) {
  if (rows.length === 0) {
    console.log("No matching requests.");
    return;
  }
  const columns = Object.keys(rows[0]);
  const widths = columns.map((col) =>
    Math.max(col.length, ...rows.map((row) => String(row[col] ?? "").length)),
  );
  const printRow = (cells) => cells.map((cell, i) => String(cell).padEnd(widths[i])).join("  ");

  console.log(printRow(columns));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) {
    console.log(printRow(columns.map((col) => row[col] ?? "")));
  }
}

function printCsv(rows) {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]);
  console.log(columns.map(csvEscape).join(","));
  for (const row of rows) {
    console.log(columns.map((col) => csvEscape(row[col])).join(","));
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function requireResource(type) {
  const resource = RESOURCES[type];
  if (!resource) fail(`--type must be one of: ${Object.keys(RESOURCES).join(", ")}`);
  return resource;
}

function cmdList(flags) {
  const resource = requireResource(flags.type);
  const env = flags.env;
  const database = resource.database(env);
  const format = flags.format ?? "table";

  let sql = `SELECT * FROM ${resource.table}`;
  if (flags.status) {
    if (!STATUSES.has(flags.status)) fail(`--status must be one of: ${[...STATUSES].join(", ")}`);
    sql += ` WHERE status = '${flags.status}'`;
  }
  sql += " ORDER BY created_at DESC";

  const rows = d1Execute(database, sql);

  // For video submissions, collapse the type-specific columns into one
  // human-readable "source" column instead of a wide, mostly-empty table.
  const shaped =
    flags.type === "video"
      ? rows.map((row) => ({
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
        }))
      : rows;

  if (format === "json") console.log(JSON.stringify(rows, null, 2));
  else if (format === "csv") printCsv(shaped);
  else printTable(shaped);
}

function cmdUpdate(flags) {
  const resource = requireResource(flags.type);
  const env = flags.env;
  const database = resource.database(env);

  const id = Number(flags.id);
  if (!Number.isInteger(id) || id <= 0) fail("--id must be a positive integer.");
  if (!STATUSES.has(flags.status)) fail(`--status must be one of: ${[...STATUSES].join(", ")}`);

  d1Execute(database, `UPDATE ${resource.table} SET status = '${flags.status}' WHERE id = ${id}`);
  console.log(`${flags.type} #${id} -> ${flags.status}`);

  if (flags.type !== "video" || flags.status !== "approved") return;

  const rows = d1Execute(database, `SELECT submission_type, url FROM video_submissions WHERE id = ${id}`);
  const row = rows[0];
  if (!row) return;

  if (row.submission_type === "upload") {
    console.log(`This is a raw upload — pull it locally with:`);
    console.log(`  node scripts/admin-requests.mjs download --id ${id} --out <path>${env ? ` --env ${env}` : ""}`);
    return;
  }

  if (!row.url) return;
  const csvRows = parseCsvRows(MASTER_CSV);
  if (csvRows.some((r) => r.link === row.url)) {
    console.log(`${row.url} is already in the master CSV — skipped.`);
    return;
  }
  csvRows.push({ link: row.url, status: "", videoId: "", notes: `submitted via web form (submission #${id})` });
  writeCsvRows(MASTER_CSV, csvRows);
  console.log(`Appended ${row.url} to ${path.basename(MASTER_CSV)} for the next collect-batch.mjs run.`);
}

function cmdDownload(flags) {
  const env = flags.env;
  const database = RESOURCES.video.database(env);
  const id = Number(flags.id);
  if (!Number.isInteger(id) || id <= 0) fail("--id must be a positive integer.");
  if (!flags.out) fail("--out <path> is required.");

  const rows = d1Execute(
    database,
    `SELECT submission_type, r2_key FROM video_submissions WHERE id = ${id}`,
  );
  const row = rows[0];
  if (!row) fail(`No video submission with id ${id}.`);
  if (row.submission_type !== "upload") fail(`Submission #${id} is a link, not a raw upload.`);
  if (!row.r2_key) fail(`Submission #${id} has no file yet (upload step never completed).`);

  r2Get(UPLOAD_BUCKET(env), row.r2_key, flags.out);
  console.log(`Saved to ${flags.out}`);
}

// ---------------------------------------------------------------------------

const { command, flags } = parseArgs(process.argv.slice(2));

switch (command) {
  case "list":
    cmdList(flags);
    break;
  case "update":
    cmdUpdate(flags);
    break;
  case "download":
    cmdDownload(flags);
    break;
  default:
    fail(
      "Usage:\n" +
        "  node scripts/admin-requests.mjs list --type takedown|video [--status <s>] [--format table|csv|json] [--env staging]\n" +
        "  node scripts/admin-requests.mjs update --type takedown|video --id <n> --status <new|reviewing|approved|rejected|done> [--env staging]\n" +
        "  node scripts/admin-requests.mjs download --id <n> --out <path> [--env staging]",
    );
}
