#!/usr/bin/env node
// Batch-collects many public video URLs (initially: Instagram reels) into the
// archive by shelling out to scripts/collect.mjs once per URL, strictly
// serially. See docs/content-pipeline.md for the single-URL pipeline this
// wraps.
//
// Usage: node scripts/collect-batch.mjs <csv-path>
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const VIDEOS_JSON = path.join(ROOT, "src/data/videos.json");
const COLLECT_SCRIPT = path.join(ROOT, "scripts/collect.mjs");

const BREW_HINT = "brew install yt-dlp ffmpeg";

// Where the per-URL run log gets written. This is intentionally NOT inside
// the repo (it's a run artifact, not archive content). Override with
// BLACKDAYS_SCRATCH_DIR for reuse outside this particular session.
const SCRATCH_DIR =
  process.env.BLACKDAYS_SCRATCH_DIR ||
  "/private/tmp/claude-501/-Users-rajtalekar-workspace-blackdays/c77d20f5-fa3f-408e-bf2a-aa49767d6c2b/scratchpad";
const LOG_FILE = path.join(SCRATCH_DIR, "collect-batch-log.json");

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
// CSV parsing
// ---------------------------------------------------------------------------

function parseCsvUrls(csvPath) {
  if (!existsSync(csvPath)) {
    console.error(`CSV not found: ${csvPath}`);
    process.exit(1);
  }
  const raw = readFileSync(csvPath, "utf8");
  const lines = raw.split(/\r?\n/);
  // Skip header row (assumed to be the first line, e.g. "Links").
  return lines
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
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

  const rawUrls = parseCsvUrls(csvPath);
  console.log(`Parsed ${rawUrls.length} URL(s) from ${csvPath}.`);

  const existingVideos = readExistingVideos();
  const existingNormalized = new Set(
    existingVideos
      .map((v) => v?.source?.url)
      .filter(Boolean)
      .map(normalizeInstagramUrl),
  );

  const seenThisRun = new Set();
  const worklist = []; // { normalizedUrl }
  const skippedDuplicates = []; // { rawUrl, normalizedUrl, reason }

  for (const rawUrl of rawUrls) {
    const normalizedUrl = normalizeInstagramUrl(rawUrl);
    if (existingNormalized.has(normalizedUrl)) {
      skippedDuplicates.push({ rawUrl, normalizedUrl, reason: "already-in-videos.json" });
      continue;
    }
    if (seenThisRun.has(normalizedUrl)) {
      skippedDuplicates.push({ rawUrl, normalizedUrl, reason: "duplicate-within-csv" });
      continue;
    }
    seenThisRun.add(normalizedUrl);
    worklist.push({ normalizedUrl });
  }

  console.log(
    `${worklist.length} URL(s) to attempt, ${skippedDuplicates.length} skipped as duplicate.`,
  );

  const runLog = [];
  const total = worklist.length;
  let processed = 0;
  let abortedBySafetyValve = false;

  function recordAndPrint(entry) {
    runLog.push(entry);
    const label = shortcodeOf(entry.url);
    if (entry.status === "ok") {
      console.log(`[${processed}/${total}] ${label} → ok (${entry.id})`);
    } else if (entry.status === "duplicate") {
      console.log(`[${processed}/${total}] ${label} → skipped: duplicate (${entry.error})`);
    } else {
      console.log(`[${processed}/${total}] ${label} → failed: ${entry.error}`);
    }
  }

  function attempt(normalizedUrl) {
    const result = collectOne(normalizedUrl);
    const timestamp = new Date().toISOString();
    if (result.ok) {
      return { url: normalizedUrl, status: "ok", id: result.id, error: null, timestamp };
    }
    if (result.duplicate) {
      return { url: normalizedUrl, status: "duplicate", id: null, error: result.error, timestamp };
    }
    return { url: normalizedUrl, status: "failed", id: null, error: result.error, timestamp };
  }

  // -------------------------------------------------------------------------
  // Safety valve: process first SAFETY_VALVE_COUNT, then evaluate.
  // -------------------------------------------------------------------------

  const safetyCount = Math.min(SAFETY_VALVE_COUNT, worklist.length);
  for (let i = 0; i < safetyCount; i++) {
    processed++;
    const entry = attempt(worklist[i].normalizedUrl);
    recordAndPrint(entry);
    if (i < safetyCount - 1) {
      sleepSeconds(randomDelay(MAIN_DELAY_MIN_S, MAIN_DELAY_MAX_S));
    }
  }

  const safetyResults = runLog.slice(0, safetyCount);
  const safetySucceeded = safetyResults.some((r) => r.status === "ok");

  if (safetyCount > 0 && !safetySucceeded) {
    abortedBySafetyValve = true;
    console.error(
      `\nSafety valve triggered: all ${safetyCount} of the first ${safetyCount} attempts failed. ` +
        `Aborting the remaining ${total - safetyCount} — Instagram is likely walling this IP; ` +
        `burning through the rest would achieve nothing and risk making it worse.`,
    );
  }

  // -------------------------------------------------------------------------
  // Main loop over the remainder (only if safety valve didn't trip).
  // -------------------------------------------------------------------------

  if (!abortedBySafetyValve) {
    for (let i = safetyCount; i < worklist.length; i++) {
      sleepSeconds(randomDelay(MAIN_DELAY_MIN_S, MAIN_DELAY_MAX_S));
      processed++;
      const entry = attempt(worklist[i].normalizedUrl);
      recordAndPrint(entry);
    }
  }

  // -------------------------------------------------------------------------
  // Retry pass: failures only, once, longer spacing.
  // -------------------------------------------------------------------------

  const retryLog = [];
  if (!abortedBySafetyValve) {
    const failedEntries = runLog.filter((e) => e.status === "failed");
    if (failedEntries.length > 0) {
      console.log(`\nRetry pass: ${failedEntries.length} failed URL(s), longer spacing.`);
      for (let i = 0; i < failedEntries.length; i++) {
        sleepSeconds(randomDelay(RETRY_DELAY_MIN_S, RETRY_DELAY_MAX_S));
        const original = failedEntries[i];
        const retryResult = attempt(original.url);
        retryResult.timestamp = new Date().toISOString();
        retryResult.retry = true;
        retryLog.push(retryResult);
        const label = shortcodeOf(original.url);
        if (retryResult.status === "ok") {
          console.log(`[retry ${i + 1}/${failedEntries.length}] ${label} → ok (${retryResult.id})`);
          // Update the original run log entry in place so the final log
          // reflects the outcome that stuck.
          original.status = "ok";
          original.id = retryResult.id;
          original.error = null;
          original.retriedAt = retryResult.timestamp;
        } else {
          console.log(
            `[retry ${i + 1}/${failedEntries.length}] ${label} → failed again: ${retryResult.error}`,
          );
          original.retriedAt = retryResult.timestamp;
          original.retryError = retryResult.error;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Write run log
  // -------------------------------------------------------------------------

  mkdirSync(SCRATCH_DIR, { recursive: true });
  const logPayload = {
    csvPath,
    totalParsed: rawUrls.length,
    totalAttempted: total,
    skippedDuplicates,
    abortedBySafetyValve,
    entries: runLog,
    retryAttempts: retryLog,
    finishedAt: new Date().toISOString(),
  };
  writeFileSync(LOG_FILE, JSON.stringify(logPayload, null, 2) + "\n");
  console.log(`\nRun log written to ${LOG_FILE}`);

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------

  const succeeded = runLog.filter((e) => e.status === "ok");
  const stillFailed = runLog.filter((e) => e.status === "failed");
  const duplicatesDuringRun = runLog.filter((e) => e.status === "duplicate");

  console.log("\n--- Summary ---");
  console.log(`Attempted: ${total}`);
  console.log(`Succeeded: ${succeeded.length}`);
  console.log(`Failed after retry: ${stillFailed.length}`);
  console.log(`Duplicate (caught mid-run by collect.mjs itself): ${duplicatesDuringRun.length}`);
  console.log(`Skipped as duplicate before any network call: ${skippedDuplicates.length}`);
  if (abortedBySafetyValve) {
    console.log("Run was ABORTED by the safety valve after the first attempts all failed.");
  }
}

// Only run when executed directly (`node scripts/collect-batch.mjs ...`), not
// when imported by another module wanting normalizeInstagramUrl.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
