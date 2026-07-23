#!/usr/bin/env node
// Turns an approved raw-upload video submission (already downloaded locally
// via r2Get, from its `pending/` R2 key) into a published-media entry:
// transcode/remux (mirroring scripts/lib/transcode.mjs's collect.mjs-derived
// logic), thumbnail, upload straight to the shared blackdays-media R2 bucket
// (never the stale public/media/ path scripts/collect.mjs still writes to —
// see CLAUDE.md), and append a draft videos.json entry with "TODO"
// placeholders for whatever needs a human's judgment.
//
// Called in-process from admin-tui.mjs (not as a subprocess) — this
// pipeline runs exactly once per approved submission and never overlaps
// another instance in normal single-operator use, unlike collect-batch.mjs's
// deliberate subprocess-per-URL isolation, which exists specifically to
// avoid a videos.json read-modify-write race across many serial URLs — a
// different concern that doesn't apply here.
//
// video_submissions.contact (the submitter's email/handle) is deliberately
// never read here: VideoEntry (src/lib/schema.ts) has no field for it, and
// writing it into videos.json — a file that ships into the public static
// site build — would leak submitter PII onto the public site. Callers that
// want to follow up with a submitter must read `contact` themselves from the
// D1 row and keep it out of anything written to disk here.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MEDIA_BUCKET, r2Put } from "./admin-resources.mjs";
import { generateThumbnail, probe, transcodeForWeb } from "./transcode.mjs";
import { getCacheDir } from "./review-cache.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const VIDEOS_JSON = path.join(ROOT, "src/data/videos.json");

const VIDEO_ID_RE = /^video-(\d{3})$/;

function readExistingVideos() {
  if (!existsSync(VIDEOS_JSON)) return [];
  const raw = readFileSync(VIDEOS_JSON, "utf8").trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function nextVideoId(existingVideos) {
  const maxExisting = existingVideos.reduce((max, v) => {
    const match = VIDEO_ID_RE.exec(v.id ?? "");
    if (!match) return max;
    return Math.max(max, Number(match[1]));
  }, 0);
  return `video-${String(maxExisting + 1).padStart(3, "0")}`;
}

// Runs the full pipeline synchronously; throws on any failure. The caller
// (admin-tui.mjs) is responsible for re-checking the submission's D1 status
// fresh immediately before calling this, to guard against re-ingesting an
// already-approved row — id assignment is "max existing + 1", so a duplicate
// run creates a duplicate video-NNN entry rather than overwriting the first.
export function runUploadIngest({ localFilePath, submissionRow }) {
  const cacheDir = getCacheDir();
  const existingVideos = readExistingVideos();
  const id = nextVideoId(existingVideos);

  const webVideoPath = path.join(cacheDir, `${id}-web.mp4`);
  const thumbPath = path.join(cacheDir, `${id}-thumb.jpg`);

  transcodeForWeb(localFilePath, webVideoPath);
  generateThumbnail(webVideoPath, thumbPath);
  const { duration, width, height } = probe(webVideoPath);

  const videoKey = `videos/${id}.mp4`;
  const thumbKey = `thumbnails/${id}.jpg`;

  // R2 uploads happen before the videos.json write: if the write below
  // fails, the media already exists under a known id/key, recoverable by a
  // human (or a retry, which just overwrites the same keys) rather than
  // silently orphaned.
  r2Put(MEDIA_BUCKET, videoKey, webVideoPath, { quiet: true });
  r2Put(MEDIA_BUCKET, thumbKey, thumbPath, { quiet: true });

  const today = new Date().toISOString().slice(0, 10);
  const description = submissionRow.description?.trim() || "TODO";
  const date = submissionRow.event_date?.trim() || "TODO";

  const entry = {
    id,
    title: "TODO",
    description,
    date,
    location: "TODO",
    tags: ["TODO"],
    verificationStatus: "unverified",
    footageOrigin: "participant",
    source: {
      platform: "Direct upload",
      url: "",
      uploader: `Submission #${submissionRow.id}`,
      publishedAt: date,
    },
    media: {
      video: videoKey,
      thumbnail: thumbKey,
      duration,
      width,
      height,
    },
    archivedAt: today,
  };

  const mergedVideos = [...existingVideos, entry];
  writeFileSync(VIDEOS_JSON, JSON.stringify(mergedVideos, null, 2) + "\n");

  const todoFields = ["title", "location", "tags"];
  if (description === "TODO") todoFields.push("description");
  if (date === "TODO") todoFields.push("date");

  return { id, videoKey, thumbKey, todoFields };
}
