#!/usr/bin/env node
// Bulk-ingests a batch of already-downloaded raw video files (e.g. pulled
// from a shared Google Drive folder of contributed protest footage) into the
// archive. Unlike scripts/collect.mjs (one platform URL via yt-dlp) or
// scripts/lib/upload-ingest.mjs (one file already in the private
// blackdays-uploads R2 bucket, tied to a web-form submission), this handles a
// local directory of files with no resolvable platform URL and no D1 row.
//
// Two-phase by design: `ingest` does technical processing only (transcode,
// thumbnail, probe, frame extraction) and writes draft videos.json entries
// with "TODO" editorial-field placeholders — it never guesses description,
// date, location, tags, or footageOrigin. A human (or an LLM agent viewing
// the extracted frames) fills those in directly in videos.json afterward.
// `publish` is a separate, explicit step that only pushes media to the
// public R2 bucket once every entry in the batch is fully filled in — see
// docs/content-pipeline.md and the "editorial rules" it lists.
//
// Usage:
//   node scripts/ingest-drive-batch.mjs ingest --dir <path> [--manifest <path>] [--frames 5]
//   node scripts/ingest-drive-batch.mjs publish [--env staging|production]

import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  commandExists,
  generateFrames,
  generateThumbnail,
  humanSize,
  probe,
  transcodeForWeb,
} from "./lib/transcode.mjs";
import { MEDIA_BUCKET, r2Put } from "./lib/admin-resources.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const ARCHIVE_DIR = path.join(ROOT, "archive-originals");
const VIDEOS_JSON = path.join(ROOT, "src/data/videos.json");
const HASH_MANIFEST = path.join(ROOT, "scripts/data/ingest-content-hashes.json");

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm"]);
const VIDEO_ID_RE = /^video-(\d{3})$/;
const BREW_HINT = "brew install ffmpeg";

// ---------------------------------------------------------------------------
// Scratch dir (never committed — cache + resumable state live here, same
// convention as scripts/enrich.mjs).
// ---------------------------------------------------------------------------

if (!process.env.BLACKDAYS_SCRATCH_DIR) {
  console.error(
    "BLACKDAYS_SCRATCH_DIR is not set. Point it at a directory outside the repo " +
      "for the transcode cache, extracted frames, and resumable state " +
      "(e.g. export BLACKDAYS_SCRATCH_DIR=/tmp/blackdays-scratch).",
  );
  process.exit(1);
}
const SCRATCH_DIR = process.env.BLACKDAYS_SCRATCH_DIR;
const CACHE_DIR = path.join(SCRATCH_DIR, "ingest-cache");
const FRAMES_DIR = path.join(SCRATCH_DIR, "ingest-frames");
const STATE_FILE = path.join(SCRATCH_DIR, "ingest-drive-batch-state.json");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      flags[key] = argv[i + 1];
      i++;
    }
  }
  return flags;
}

function readJsonArray(file) {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf8").trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function readJsonObject(file) {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, "utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  return readJsonObject(STATE_FILE);
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

function nextVideoId(existingVideos) {
  const maxExisting = existingVideos.reduce((max, v) => {
    const match = VIDEO_ID_RE.exec(v.id ?? "");
    if (!match) return max;
    return Math.max(max, Number(match[1]));
  }, 0);
  return `video-${String(maxExisting + 1).padStart(3, "0")}`;
}

function preflight() {
  if (!commandExists("ffmpeg")) {
    console.error(`ffmpeg not found on PATH.\n\n  ${BREW_HINT}\n`);
    process.exit(1);
  }
  if (!commandExists("ffprobe")) {
    console.error(`ffprobe not found on PATH (ships with ffmpeg).\n\n  ${BREW_HINT}\n`);
    process.exit(1);
  }
}

// Recursively walk every string field in a videos.json entry and check for a
// literal "TODO" — mirrors src/lib/schema.ts's checkNoTodoStrings exactly, so
// `publish` can gate on the same rule the build enforces, before the build.
function findTodoFields(value, path = "") {
  const found = [];
  if (typeof value === "string") {
    if (value === "TODO") found.push(path || "(root)");
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => found.push(...findTodoFields(item, `${path}[${i}]`)));
    return found;
  }
  if (value && typeof value === "object") {
    for (const [key, val] of Object.entries(value)) {
      found.push(...findTodoFields(val, path ? `${path}.${key}` : key));
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// ingest
// ---------------------------------------------------------------------------

async function runIngest(flags) {
  const dir = flags.dir;
  if (!dir) {
    console.error("Usage: node scripts/ingest-drive-batch.mjs ingest --dir <path> [--manifest <path>] [--frames 5]");
    process.exit(1);
  }
  const frameCount = Number(flags.frames || 5);

  preflight();
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });
  mkdirSync(FRAMES_DIR, { recursive: true });
  mkdirSync(path.dirname(HASH_MANIFEST), { recursive: true });

  const manifest = flags.manifest ? readJsonObject(flags.manifest) : {};
  const hashManifest = readJsonObject(HASH_MANIFEST);
  const state = loadState();

  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && VIDEO_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort();

  console.log(`Found ${files.length} video file(s) in ${dir}.`);

  let skipped = 0;
  let ingested = 0;

  for (const filename of files) {
    const sourceFile = path.join(dir, filename);

    // ---- 1. sha256 dedup (tracked manifest — survives across clones) ----
    const hash = await sha256File(sourceFile);
    if (hashManifest[hash]) {
      console.log(`[skip] ${filename} — already ingested as ${hashManifest[hash]} (sha256 match)`);
      skipped++;
      continue;
    }

    // ---- 2. assign next sequential id (fresh read, same as collect.mjs) ----
    const existingVideos = readJsonArray(VIDEOS_JSON);
    const id = nextVideoId(existingVideos);

    console.log(`[${id}] processing ${filename}...`);

    // ---- 3. transcode + thumbnail + probe (into scratch cache, not public/media/ or R2 yet) ----
    const videoFile = path.join(CACHE_DIR, `${id}.mp4`);
    const thumbFile = path.join(CACHE_DIR, `${id}.jpg`);
    const transcodeResult = transcodeForWeb(sourceFile, videoFile);
    console.log(`  transcode: ${transcodeResult.method}`);
    generateThumbnail(videoFile, thumbFile);
    const { duration, width, height } = probe(videoFile);

    // ---- 4. archive original ----
    const archiveFile = path.join(ARCHIVE_DIR, `${id}${path.extname(filename)}`);
    writeFileSync(archiveFile, readFileSync(sourceFile));

    // ---- 5. extract frames for metadata drafting ----
    const frameOutDir = path.join(FRAMES_DIR, id);
    mkdirSync(frameOutDir, { recursive: true });
    const framePaths = generateFrames(videoFile, frameOutDir, frameCount, duration);

    // ---- 6. append draft entry ----
    const manifestUrl = manifest[filename];
    const entry = {
      id,
      title: "TODO",
      description: "TODO",
      date: "TODO",
      // location intentionally omitted — schema.ts: never a guessed placeholder.
      tags: ["TODO"],
      verificationStatus: "unverified",
      footageOrigin: "TODO",
      source: {
        platform: "Google Drive",
        url: manifestUrl || "",
        uploader: "Community contributor (Google Drive)",
        publishedAt: "TODO",
      },
      media: {
        video: `videos/${id}.mp4`,
        thumbnail: `thumbnails/${id}.jpg`,
        duration,
        width,
        height,
      },
      archivedAt: new Date().toISOString().slice(0, 10),
    };
    const mergedVideos = [...existingVideos, entry];
    writeFileSync(VIDEOS_JSON, JSON.stringify(mergedVideos, null, 2) + "\n");

    // ---- 7. record state (hash manifest committed; run state scratch-only) ----
    hashManifest[hash] = id;
    writeFileSync(HASH_MANIFEST, JSON.stringify(hashManifest, null, 2) + "\n");

    state[id] = {
      sourceFile: filename,
      sha256: hash,
      cachedVideo: videoFile,
      cachedThumb: thumbFile,
      framePaths,
      manifestUrl: manifestUrl || null,
      status: "awaiting-metadata",
    };
    saveState(state);

    console.log(`  archived, cached video ${humanSize(statSync(videoFile).size)}, ${framePaths.length} frame(s) at ${frameOutDir}`);
    ingested++;
  }

  console.log(`\nIngested ${ingested}, skipped ${skipped} (already-seen sha256).`);
  console.log(`State file: ${STATE_FILE}`);
  console.log(
    `\nNext: view each id's frames and fill in title/description/date/tags/footageOrigin ` +
      `(and location, if confident) directly in videos.json, then mark it "metadata-done" ` +
      `in the state file before running the publish step.`,
  );
}

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

function runPublish(flags) {
  const state = loadState();
  const ids = Object.keys(state);
  if (ids.length === 0) {
    console.error(`No batch state found at ${STATE_FILE}. Run "ingest" first.`);
    process.exit(1);
  }

  const notDone = ids.filter((id) => state[id].status !== "metadata-done");
  if (notDone.length > 0) {
    console.error(
      `${notDone.length} entr(y/ies) not yet marked "metadata-done": ${notDone.join(", ")}\n` +
        `Fill in their editorial fields in videos.json and update the state file before publishing.`,
    );
    process.exit(1);
  }

  // Defense-in-depth: re-read videos.json and check the actual committed
  // fields for this batch, not just trust the state file's status flag.
  const existingVideos = readJsonArray(VIDEOS_JSON);
  const videosById = new Map(existingVideos.map((v) => [v.id, v]));
  const todoOffenders = [];
  for (const id of ids) {
    const entry = videosById.get(id);
    if (!entry) {
      console.error(`Entry ${id} from state file is missing from videos.json.`);
      process.exit(1);
    }
    const todoFields = findTodoFields(entry);
    if (todoFields.length > 0) {
      todoOffenders.push(`${id}: ${todoFields.join(", ")}`);
    }
  }
  if (todoOffenders.length > 0) {
    console.error(`Literal "TODO" fields still present:\n  ${todoOffenders.join("\n  ")}`);
    process.exit(1);
  }

  console.log(`All ${ids.length} entries clean of "TODO" — pushing media to R2 (${MEDIA_BUCKET})...`);

  for (const id of ids) {
    const entryState = state[id];
    console.log(`[${id}] pushing video + thumbnail...`);
    r2Put(MEDIA_BUCKET, `videos/${id}.mp4`, entryState.cachedVideo);
    r2Put(MEDIA_BUCKET, `thumbnails/${id}.jpg`, entryState.cachedThumb);
    state[id].status = "published";
  }
  saveState(state);

  const withManifestUrl = ids.filter((id) => state[id].manifestUrl).length;
  console.log(`\n--- PR body draft ---`);
  console.log(`Added ${ids.length} entries from the Google Drive batch: ${ids.join(", ")}`);
  console.log(
    `Attribution: ${withManifestUrl}/${ids.length} got a specific per-file Drive link; ` +
      `the remainder have source.url: "" (no specific link available), matching the existing ` +
      `convention for submissions without one.`,
  );
  console.log(
    `\nEvery entry is verificationStatus: "unverified" (no independent provenance check was ` +
      `performed — only technical ingestion + factual visible-content description).`,
  );
  console.log(`\nMedia is now live at ${MEDIA_BUCKET} — review the entries on staging before merging.`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const [, , subcommand, ...rest] = process.argv;
const flags = parseArgs(rest);

if (subcommand === "ingest") {
  await runIngest(flags);
} else if (subcommand === "publish") {
  runPublish(flags);
} else {
  console.error(
    "Usage:\n" +
      "  node scripts/ingest-drive-batch.mjs ingest --dir <path> [--manifest <path>] [--frames 5]\n" +
      "  node scripts/ingest-drive-batch.mjs publish",
  );
  process.exit(1);
}
