#!/usr/bin/env node
// Batch-collects many public video URLs (initially: Instagram reels) into the
// archive by shelling out to scripts/collect.mjs once per URL, strictly
// serially. See docs/content-pipeline.md for the single-URL pipeline this
// wraps.
//
// Usage: node scripts/collect-batch.mjs <csv-path>
//
// The CSV is both the input queue and the run's own status log: columns are
// Link,Status,VideoId,Notes. Status is one of:
//   - "" (blank)  — never attempted; attempt it this run.
//   - "failed"    — a prior run tried and it didn't stick, but nothing marked
//                    it permanently dead; retry it this run.
//   - "ignored"   — a human (or a prior run's classification) decided this
//                    link will never publish (age/audience-restricted, no
//                    video in the post, out-of-scope/misattributed content,
//                    etc). Terminal — never retried automatically. Change it
//                    back to blank by hand to force a retry.
//   - "published" — already in videos.json (VideoId column has the id).
//                    Terminal, skipped.
// After every attempt this script rewrites the CSV in place with the new
// Status/VideoId/Notes for that row, so a run that's interrupted partway
// through leaves accurate state for the next one. The maintainer appends new
// links to the same file over time (Status left blank for new rows).
//
// HARD RULES (do not relax these — see the task this script was written for):
//   - Never import or modify collect.mjs. Always spawn it as a child process
//     and wait for full exit before starting the next one. Concurrency of
//     exactly 1. collect.mjs does an unlocked read-modify-write of
//     src/data/videos.json and assigns ids as max(existing)+1 read fresh from
//     that file; two overlapping runs would race and silently drop an entry.
//   - Never delete or overwrite anything in archive-originals/.
//   - Pace requests to Instagram politely (this file's RETRY_DELAY constants)
//     — recon showed roughly a third of requests get soft-walled and fail
//     quietly (empty 200 body) rather than with a loud 429. A slow complete
//     run beats a fast blocked one; do not tighten the delays casually.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const VIDEOS_JSON = path.join(ROOT, "src/data/videos.json");
const COLLECT_SCRIPT = path.join(ROOT, "scripts/collect.mjs");

const BREW_HINT = "brew install yt-dlp ffmpeg";

// Politeness pacing. Do not tighten — see header comment.
const MAIN_DELAY_MIN_S = 20;
const MAIN_DELAY_MAX_S = 40;
const RETRY_DELAY_MIN_S = 60;
const RETRY_DELAY_MAX_S = 90;

const SAFETY_VALVE_COUNT = 3;

// ---------------------------------------------------------------------------
// Prereq checks (preflight, before any network call)
// ---------------------------------------------------------------------------

function commandExists(cmd, versionArgs = ["-version"]) {
  const res = spawnSync(cmd, versionArgs);
  return !res.error && res.status === 0;
}

function preflight() {
  if (!commandExists("yt-dlp", ["--version"])) {
    console.error(`yt-dlp not found on PATH.\n\n  ${BREW_HINT}\n`);
    process.exit(1);
  }
  if (!commandExists("ffmpeg")) {
    console.error(`ffmpeg not found on PATH.\n\n  ${BREW_HINT}\n`);
    process.exit(1);
  }
  if (!commandExists("ffprobe")) {
    console.error(`ffprobe not found on PATH (ships with ffmpeg).\n\n  ${BREW_HINT}\n`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// URL normalization — exported pure function, reusable by later pipeline
// stages. Strips ALL query params (igsh is a share-tracking token tied to the
// user's session and must never be stored), forces https + www.instagram.com,
// and collapses to a single trailing slash. Non-Instagram URLs (e.g. the
// existing video-010..013 X/Twitter entries) are left on their own host —
// this function must never mutate an unrelated platform's URL, it only
// canonicalizes Instagram's own query/host/slash quirks.
// ---------------------------------------------------------------------------

export function normalizeInstagramUrl(rawUrl) {
  const trimmed = String(rawUrl).trim();
  let u;
  try {
    u = new URL(trimmed);
  } catch {
    u = new URL(`https://${trimmed.replace(/^\/\//, "")}`);
  }

  const host = u.hostname.toLowerCase();
  const isInstagram = host === "instagram.com" || host.endsWith(".instagram.com");

  if (!isInstagram) {
    // Not Instagram — normalize generically (https, no query/hash, single
    // trailing slash) but preserve the host untouched.
    const pathname = u.pathname.replace(/\/+$/, "");
    return `https://${host}${pathname}/`;
  }

  // Instagram content lives under /reel/<code>/, /reels/<code>/, /p/<code>/,
  // or /tv/<code>/. Preserve the actual content type (a /p/ post is not
  // necessarily a reel/video) rather than forcing everything to /reel/.
  const pathMatch = u.pathname.match(/\/(reel|reels|p|tv)\/([^/]+)/i);
  let pathname;
  if (pathMatch) {
    const type = pathMatch[1].toLowerCase() === "reels" ? "reel" : pathMatch[1].toLowerCase();
    pathname = `/${type}/${pathMatch[2]}/`;
  } else {
    pathname = u.pathname.replace(/\/+$/, "") + "/";
  }

  return `https://www.instagram.com${pathname}`;
}

// ---------------------------------------------------------------------------
// CSV read/write. Minimal RFC4180-ish support (quoted fields, "" escaping
// embedded quotes) — enough for our own data (URLs, short status words, one
// free-text Notes column). No external dependency; this repo doesn't use one.
//
// Two shapes are accepted for backwards compatibility:
//   - New: "Link,Status,VideoId,Notes" header.
//   - Old: single "Links" column (the original archive-collection CSV,
//     before the status column existed). Old rows are treated as freshly
//     added with blank status.
// ---------------------------------------------------------------------------

function parseCsvLine(line) {
  const fields = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      fields.push(field);
      field = "";
    } else {
      field += c;
    }
  }
  fields.push(field);
  return fields;
}

function csvField(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function parseCsvRows(csvPath) {
  if (!existsSync(csvPath)) {
    console.error(`CSV not found: ${csvPath}`);
    process.exit(1);
  }
  const raw = readFileSync(csvPath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l, i, arr) => l.length > 0 || i < arr.length - 1);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const isNewFormat = header[0] === "link";

  const rows = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const fields = parseCsvLine(line);
    if (isNewFormat) {
      rows.push({
        link: (fields[0] || "").trim(),
        status: (fields[1] || "").trim().toLowerCase(),
        videoId: (fields[2] || "").trim(),
        notes: fields[3] || "",
      });
    } else {
      // Old single-column format: every row is an unattempted link.
      rows.push({ link: fields[0].trim(), status: "", videoId: "", notes: "" });
    }
  }
  return rows;
}

export function writeCsvRows(csvPath, rows) {
  const lines = ["Link,Status,VideoId,Notes"];
  for (const row of rows) {
    lines.push(
      [row.link, row.status, row.videoId, row.notes].map(csvField).join(","),
    );
  }
  writeFileSync(csvPath, lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Existing archive state (read once, for the dedupe pass; each collect.mjs
// child re-reads it fresh for id assignment — we never cache that part).
// ---------------------------------------------------------------------------

function readExistingVideos() {
  if (!existsSync(VIDEOS_JSON)) return [];
  const raw = readFileSync(VIDEOS_JSON, "utf8").trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

// ---------------------------------------------------------------------------
// Sync sleep (blocking) via the `sleep` binary — keeps the whole script
// simple, synchronous, and trivially serial: nothing here uses Promise.all
// or a worker pool, spawnSync already blocks until the child fully exits.
// ---------------------------------------------------------------------------

function sleepSeconds(seconds) {
  spawnSync("sleep", [String(seconds)]);
}

function randomDelay(minS, maxS) {
  return minS + Math.random() * (maxS - minS);
}

// ---------------------------------------------------------------------------
// Run one URL through collect.mjs. Never imported — always a fresh child
// process, waited on to full exit before returning.
// ---------------------------------------------------------------------------

function collectOne(url) {
  const res = spawnSync("node", [COLLECT_SCRIPT, url], {
    cwd: ROOT,
    encoding: "utf8",
  });

  const stdout = res.stdout || "";
  const stderr = res.stderr || "";

  if (res.status === 0) {
    const idMatch = stdout.match(/Assigned id: (video-\d{3})/);
    return {
      ok: true,
      id: idMatch ? idMatch[1] : null,
      stdout,
      stderr,
    };
  }

  const isDuplicate = /^Duplicate:/m.test(stderr);
  return {
    ok: false,
    duplicate: isDuplicate,
    error: (stderr.trim() || stdout.trim() || `exit code ${res.status}`).split("\n").slice(0, 3).join(" | "),
    stdout,
    stderr,
  };
}

function shortcodeOf(normalizedUrl) {
  const m = normalizedUrl.match(/\/(?:reel|reels|p|tv)\/([^/]+)\//);
  return m ? m[1] : normalizedUrl;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error("Usage: node scripts/collect-batch.mjs <csv-path>");
    process.exit(1);
  }

  preflight();

  const rows = parseCsvRows(csvPath);
  console.log(`Parsed ${rows.length} row(s) from ${csvPath}.`);

  const persist = () => writeCsvRows(csvPath, rows);
  // Persist immediately so a pre-existing old-format ("Links"-only) file gets
  // upgraded to the new columns even if this run ends up attempting nothing.
  persist();

  const existingVideos = readExistingVideos();
  const videoIdByNormalizedUrl = new Map(
    existingVideos
      .filter((v) => v?.source?.url)
      .map((v) => [normalizeInstagramUrl(v.source.url), v.id]),
  );

  const seenThisRun = new Set(); // normalized links already claimed by an earlier row this run
  const worklist = []; // { row, normalizedUrl }
  let skippedTerminal = 0;

  for (const row of rows) {
    if (!row.link) continue;
    const normalizedUrl = normalizeInstagramUrl(row.link);
    // Persist the canonicalized link, not the raw one: strips Instagram's
    // igsh= share-tracking token (tied to whichever session generated the
    // link) and any other query noise before it ever reaches the CSV.
    row.link = normalizedUrl;

    if (row.status === "published" || row.status === "ignored") {
      skippedTerminal++;
      continue;
    }
    if (videoIdByNormalizedUrl.has(normalizedUrl)) {
      // Already published (e.g. status column wasn't updated yet by hand).
      row.status = "published";
      row.videoId = videoIdByNormalizedUrl.get(normalizedUrl);
      row.notes = "";
      skippedTerminal++;
      continue;
    }
    if (seenThisRun.has(normalizedUrl)) {
      row.status = "ignored";
      row.notes = "Duplicate of an earlier row in this CSV.";
      continue;
    }
    seenThisRun.add(normalizedUrl);
    worklist.push({ row, normalizedUrl });
  }
  persist();

  console.log(
    `${worklist.length} row(s) to attempt (blank or "failed"), ${skippedTerminal} already terminal (published/ignored).`,
  );

  const total = worklist.length;
  let processed = 0;
  let abortedBySafetyValve = false;
  const attemptedRows = []; // rows we tried this run, for the retry pass

  function applyResult(row, normalizedUrl) {
    const result = collectOne(normalizedUrl);
    if (result.ok) {
      row.status = "published";
      row.videoId = result.id;
      row.notes = "";
      return "ok";
    }
    if (result.duplicate) {
      // collect.mjs itself found this URL already in videos.json.
      row.status = "published";
      row.videoId = videoIdByNormalizedUrl.get(normalizedUrl) || row.videoId;
      row.notes = "";
      return "duplicate";
    }
    row.status = "failed";
    row.notes = result.error;
    return "failed";
  }

  function attemptAndPrint(entry) {
    processed++;
    const label = shortcodeOf(entry.normalizedUrl);
    const outcome = applyResult(entry.row, entry.normalizedUrl);
    persist();
    if (outcome === "ok") {
      console.log(`[${processed}/${total}] ${label} → published (${entry.row.videoId})`);
    } else if (outcome === "duplicate") {
      console.log(`[${processed}/${total}] ${label} → already published (${entry.row.videoId})`);
    } else {
      console.log(`[${processed}/${total}] ${label} → failed: ${entry.row.notes}`);
    }
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Safety valve: process first SAFETY_VALVE_COUNT, then evaluate.
  // -------------------------------------------------------------------------

  const safetyCount = Math.min(SAFETY_VALVE_COUNT, worklist.length);
  const safetyOutcomes = [];
  for (let i = 0; i < safetyCount; i++) {
    attemptedRows.push(worklist[i]);
    safetyOutcomes.push(attemptAndPrint(worklist[i]));
    if (i < safetyCount - 1) {
      sleepSeconds(randomDelay(MAIN_DELAY_MIN_S, MAIN_DELAY_MAX_S));
    }
  }

  const safetySucceeded = safetyOutcomes.some((o) => o === "ok" || o === "duplicate");

  if (safetyCount > 0 && !safetySucceeded) {
    abortedBySafetyValve = true;
    console.error(
      `\nSafety valve triggered: all ${safetyCount} of the first ${safetyCount} attempts failed. ` +
        `Aborting the remaining ${total - safetyCount} — Instagram is likely walling this IP; ` +
        `burning through the rest would achieve nothing and risk making it worse. Rows already ` +
        `attempted keep their "failed" status and can be retried in a later run.`,
    );
  }

  // -------------------------------------------------------------------------
  // Main loop over the remainder (only if safety valve didn't trip).
  // -------------------------------------------------------------------------

  if (!abortedBySafetyValve) {
    for (let i = safetyCount; i < worklist.length; i++) {
      sleepSeconds(randomDelay(MAIN_DELAY_MIN_S, MAIN_DELAY_MAX_S));
      attemptedRows.push(worklist[i]);
      attemptAndPrint(worklist[i]);
    }
  }

  // -------------------------------------------------------------------------
  // Retry pass: rows still "failed" after the main loop, once, longer spacing.
  // -------------------------------------------------------------------------

  if (!abortedBySafetyValve) {
    const stillFailedEntries = attemptedRows.filter((e) => e.row.status === "failed");
    if (stillFailedEntries.length > 0) {
      console.log(`\nRetry pass: ${stillFailedEntries.length} failed row(s), longer spacing.`);
      for (let i = 0; i < stillFailedEntries.length; i++) {
        sleepSeconds(randomDelay(RETRY_DELAY_MIN_S, RETRY_DELAY_MAX_S));
        const entry = stillFailedEntries[i];
        const label = shortcodeOf(entry.normalizedUrl);
        const outcome = applyResult(entry.row, entry.normalizedUrl);
        persist();
        if (outcome === "ok" || outcome === "duplicate") {
          console.log(`[retry ${i + 1}/${stillFailedEntries.length}] ${label} → published (${entry.row.videoId})`);
        } else {
          console.log(`[retry ${i + 1}/${stillFailedEntries.length}] ${label} → failed again: ${entry.row.notes}`);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Summary. The CSV itself (already persisted after every attempt) is the
  // durable record — this is just what printed to the terminal this run.
  // -------------------------------------------------------------------------

  const published = attemptedRows.filter((e) => e.row.status === "published").length;
  const stillFailed = attemptedRows.filter((e) => e.row.status === "failed").length;

  console.log("\n--- Summary ---");
  console.log(`Attempted: ${attemptedRows.length}`);
  console.log(`Published: ${published}`);
  console.log(`Still failed (retryable next run): ${stillFailed}`);
  console.log(`Already terminal, skipped: ${skippedTerminal}`);
  if (abortedBySafetyValve) {
    console.log("Run was ABORTED by the safety valve after the first attempts all failed.");
  }
  console.log(`\nCSV updated in place: ${csvPath}`);
}

// Only run when executed directly (`node scripts/collect-batch.mjs ...`), not
// when imported by another module wanting normalizeInstagramUrl.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
