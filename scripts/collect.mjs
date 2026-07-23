#!/usr/bin/env node
// Downloads, compresses, thumbnails, probes, and catalogs a single video from
// a public URL. See docs/content-pipeline.md ("Adding a video") for the spec
// this implements.
//
// Usage: node scripts/collect.mjs <public-url>

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  commandExists,
  generateThumbnail,
  humanSize,
  probe,
  run,
  transcodeForWeb,
} from "./lib/transcode.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const ARCHIVE_DIR = path.join(ROOT, "archive-originals");
const VIDEOS_DIR = path.join(ROOT, "public/media/videos");
const THUMBS_DIR = path.join(ROOT, "public/media/thumbnails");
const VIDEOS_JSON = path.join(ROOT, "src/data/videos.json");

const BREW_HINT = "brew install yt-dlp ffmpeg";

// ---------------------------------------------------------------------------
// Prereq checks
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const url = process.argv[2];
if (!url) {
  console.error("Usage: node scripts/collect.mjs <public-url>");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJsonArray(file) {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf8").trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

// ---------------------------------------------------------------------------
// Main — wrapped so any thrown error from the shared run()/transcode helpers
// prints and exits exactly like the old inline process.exit(1) calls did.
// ---------------------------------------------------------------------------

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

function main() {
  // -------------------------------------------------------------------------
  // 1. Duplicate check
  // -------------------------------------------------------------------------

  const existingVideos = readJsonArray(VIDEOS_JSON);
  const duplicate = existingVideos.find((v) => v?.source?.url === url);
  if (duplicate) {
    console.error(
      `Duplicate: this URL is already archived as "${duplicate.id}" ` +
        `(${duplicate.title ?? "(untitled)"}). Aborting.`,
    );
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // 2. Download + metadata
  // -------------------------------------------------------------------------

  mkdirSync(ARCHIVE_DIR, { recursive: true });
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "blackdays-collect-"));

  console.log(`Fetching metadata for ${url}...`);
  const metaRes = run("yt-dlp", ["--dump-json", "--no-playlist", url]);
  const meta = JSON.parse(metaRes.stdout);

  const uploader = meta.uploader || meta.channel || meta.uploader_id || "Unknown";
  const title = meta.title || "Untitled";
  const uploadDate = meta.upload_date; // YYYYMMDD or undefined
  const publishedAt = uploadDate
    ? `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`
    : "TODO";
  const platform = meta.extractor_key || meta.extractor || "Unknown";

  console.log(`Downloading (up to 1080p) into ${path.relative(ROOT, tmpDir)}...`);
  run("yt-dlp", [
    "-f",
    // Prefer an H.264 (avc1) rendition so the web copy can be remuxed rather than
    // transcoded. Instagram and X serve VP9 by default, which is ~2x more efficient
    // than H.264 — converting it necessarily inflates the file (one 1.92MiB VP9 reel
    // became 8.88MiB as H.264). Taking the platform's own H.264 rendition keeps the
    // file small AND universally playable. Falls back to any <=1080p rendition, then
    // (some portrait reels' smallest DASH stream is already >1080px tall, with no
    // avc1 or sub-1080 option at all) to whatever's available, so a valid post never
    // hard-fails purely on this filter — transcodeForWeb() below still caps the
    // output at 720px wide regardless of what was fetched here.
    "bv*[height<=1080][vcodec^=avc1]+ba/b[height<=1080][vcodec^=avc1]/bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b",
    "--no-playlist",
    "-o",
    path.join(tmpDir, "raw.%(ext)s"),
    url,
  ]);

  const rawFiles = readdirSync(tmpDir).filter((f) => f.startsWith("raw."));
  if (rawFiles.length === 0) {
    console.error("Download produced no file matching raw.*");
    process.exit(1);
  }
  const rawFile = path.join(tmpDir, rawFiles[0]);

  // -------------------------------------------------------------------------
  // 3. Normalize id: next sequential video-NNN
  // -------------------------------------------------------------------------

  const VIDEO_ID_RE = /^video-(\d{3})$/;
  const maxExisting = existingVideos.reduce((max, v) => {
    const match = VIDEO_ID_RE.exec(v.id ?? "");
    if (!match) return max;
    return Math.max(max, Number(match[1]));
  }, 0);
  const nextNumber = maxExisting + 1;
  const id = `video-${String(nextNumber).padStart(3, "0")}`;

  console.log(`Assigned id: ${id}`);

  // Archive the raw original (git-ignored archival copy).
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  const archiveFile = path.join(ARCHIVE_DIR, `${id}${path.extname(rawFile)}`);
  run("cp", [rawFile, archiveFile]);

  // -------------------------------------------------------------------------
  // 4. Compress for web
  // -------------------------------------------------------------------------

  mkdirSync(VIDEOS_DIR, { recursive: true });
  mkdirSync(THUMBS_DIR, { recursive: true });

  const videoFile = path.join(VIDEOS_DIR, `${id}.mp4`);
  const thumbFile = path.join(THUMBS_DIR, `${id}.jpg`);

  const transcodeResult = transcodeForWeb(rawFile, videoFile);
  if (transcodeResult.method === "remux") {
    console.log(
      `Source is already web-ready (${transcodeResult.sourceProbe.vcodec}, ${transcodeResult.sourceProbe.width}px) — remuxing without re-encode...`,
    );
  } else if (transcodeResult.method === "reencode") {
    console.log("Compressing for web...");
  } else {
    console.log("Compressing for web...");
    console.log(
      `Re-encode grew the file (${humanSize(transcodeResult.sourceSize)} -> ${humanSize(
        statSync(videoFile).size,
      )}); keeping the original instead.`,
    );
  }

  // -------------------------------------------------------------------------
  // 5. Thumbnail
  // -------------------------------------------------------------------------

  console.log("Generating thumbnail...");
  generateThumbnail(videoFile, thumbFile);

  // -------------------------------------------------------------------------
  // 6. Probe
  // -------------------------------------------------------------------------

  const { duration, width, height } = probe(videoFile);

  // -------------------------------------------------------------------------
  // 7. Append entry
  // -------------------------------------------------------------------------

  const TODAY = new Date().toISOString().slice(0, 10);

  const entry = {
    id,
    title,
    description: "TODO",
    date: "TODO",
    location: "TODO",
    tags: ["TODO"],
    verificationStatus: "unverified",
    footageOrigin: "TODO",
    source: {
      platform,
      url,
      uploader,
      publishedAt,
    },
    media: {
      video: `videos/${id}.mp4`,
      thumbnail: `thumbnails/${id}.jpg`,
      duration,
      width,
      height,
    },
    archivedAt: TODAY,
  };

  const mergedVideos = [...existingVideos, entry];
  writeFileSync(VIDEOS_JSON, JSON.stringify(mergedVideos, null, 2) + "\n");

  // Clean up tmp download dir (archive copy already made).
  rmSync(tmpDir, { recursive: true, force: true });

  // -------------------------------------------------------------------------
  // 8. Summary
  // -------------------------------------------------------------------------

  const videoSize = statSync(videoFile).size;
  const thumbSize = statSync(thumbFile).size;
  const archiveSize = statSync(archiveFile).size;

  console.log(`\nCollected ${id}: "${title}"`);
  console.log(`  archive original: ${path.relative(ROOT, archiveFile)} (${humanSize(archiveSize)})`);
  console.log(`  web video:        ${path.relative(ROOT, videoFile)} (${humanSize(videoSize)})`);
  console.log(`  thumbnail:        ${path.relative(ROOT, thumbFile)} (${humanSize(thumbSize)})`);
  console.log(`  duration:         ${duration}s, ${width}x${height}`);
  console.log(`  verificationStatus: unverified`);
  console.log(
    `\nWrote entry to ${path.relative(ROOT, VIDEOS_JSON)}. ` +
      `Fields description/date/location/tags/footageOrigin are "TODO" placeholders — ` +
      `fill them in before deploying; \`npm run build\` will fail until you do.`,
  );
}
