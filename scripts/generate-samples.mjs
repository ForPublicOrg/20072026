#!/usr/bin/env node
// Generates 8 placeholder video entries so the site demonstrates the full
// experience before real content exists. See docs/content-pipeline.md
// ("Sample data") for the spec this implements.
//
// Idempotent: re-running overwrites sample media files and sample entries in
// videos.json / timeline.json, but never touches non-sample entries.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const VIDEOS_DIR = path.join(ROOT, "public/media/videos");
const THUMBS_DIR = path.join(ROOT, "public/media/thumbnails");
const VIDEOS_JSON = path.join(ROOT, "src/data/videos.json");
const TIMELINE_JSON = path.join(ROOT, "src/data/timeline.json");

const BREW_HINT = "brew install yt-dlp ffmpeg";

// ---------------------------------------------------------------------------
// Prereq checks
// ---------------------------------------------------------------------------

function commandExists(cmd) {
  const res = spawnSync(cmd, ["-version"]);
  return !res.error && res.status === 0;
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
// drawtext capability: some Homebrew ffmpeg bottles (the plain `ffmpeg`
// formula) are built without libfreetype/fontconfig, so the `drawtext`
// filter doesn't exist at all. If that's the case here, look for a
// full-featured ffmpeg (e.g. the `ffmpeg-full` formula) that has it, rather
// than silently shipping clips without the SAMPLE watermark.
// ---------------------------------------------------------------------------

function listFilters(binary) {
  const res = spawnSync(binary, ["-hide_banner", "-filters"], { encoding: "utf8" });
  return res.stdout || "";
}

function supportsDrawtext(binary) {
  return /\bdrawtext\b/.test(listFilters(binary));
}

function resolveFfmpegBinary() {
  if (supportsDrawtext("ffmpeg")) return "ffmpeg";

  const candidates = [
    "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg",
    "/usr/local/opt/ffmpeg-full/bin/ffmpeg",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && supportsDrawtext(candidate)) {
      console.log(
        `Note: PATH ffmpeg has no drawtext filter (built without libfreetype/fontconfig); ` +
          `using ${candidate} to render the SAMPLE watermark.`,
      );
      return candidate;
    }
  }

  console.error(
    "ffmpeg on PATH does not support the drawtext filter (built without libfreetype/fontconfig), " +
      "and no full-featured ffmpeg install was found to fall back to.\n\n" +
      "  brew install ffmpeg-full\n",
  );
  process.exit(1);
}

const FFMPEG = resolveFfmpegBinary();
// ffprobe never needs drawtext; use the sibling binary next to whichever
// ffmpeg we resolved so probing stays consistent, falling back to PATH.
const FFPROBE = (() => {
  const sibling = path.join(path.dirname(FFMPEG), "ffprobe");
  return existsSync(sibling) ? sibling : "ffprobe";
})();

// Preflight: does drawtext work with no fontfile (i.e. does the system have
// a default font fontconfig can resolve)? If not, find a real font file on
// this Mac and pass it explicitly rather than dropping the watermark.
const FONT_CANDIDATES = [
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
];

function drawtextFilterWorks(filterExpr) {
  const res = spawnSync(FFMPEG, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=64x64:d=0.1",
    "-vf",
    filterExpr,
    "-frames:v",
    "1",
    "-f",
    "null",
    "-",
  ]);
  return res.status === 0;
}

function resolveWatermarkFontfile() {
  const plain = "drawtext=text=SAMPLE:fontsize=20:fontcolor=white:x=10:y=10";
  if (drawtextFilterWorks(plain)) {
    return null; // default font resolution works; no fontfile needed
  }

  console.log("drawtext with no fontfile failed; looking for a fontfile to pass explicitly.");
  for (const font of FONT_CANDIDATES) {
    if (!existsSync(font)) continue;
    const withFont = `drawtext=fontfile=${font}:text=SAMPLE:fontsize=20:fontcolor=white:x=10:y=10`;
    if (drawtextFilterWorks(withFont)) {
      console.log(`Using fontfile=${font} for the SAMPLE watermark.`);
      return font;
    }
  }

  console.error(
    "drawtext filter failed (missing default font) and no working fontfile was found among:\n" +
      FONT_CANDIDATES.map((f) => `  - ${f}`).join("\n") +
      "\n",
  );
  process.exit(1);
}

const WATERMARK_FONTFILE = resolveWatermarkFontfile();

function run(binary, args) {
  const res = spawnSync(binary, args, { encoding: "utf8" });
  if (res.status !== 0) {
    console.error(`Command failed: ${binary} ${args.join(" ")}`);
    console.error(res.stderr || res.stdout || "(no output)");
    process.exit(1);
  }
  return res;
}

function probe(file) {
  const res = run(FFPROBE, [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  const data = JSON.parse(res.stdout);
  const videoStream = data.streams.find((s) => s.codec_type === "video");
  const duration = Math.round(
    Number(data.format?.duration ?? videoStream?.duration ?? 0),
  );
  return {
    duration,
    width: Number(videoStream.width),
    height: Number(videoStream.height),
  };
}

// ---------------------------------------------------------------------------
// Sample plan: 8 clips, distinct dark colors, varied metadata, all 5
// verification statuses represented at least once.
// ---------------------------------------------------------------------------

const SAMPLE_PLAN = [
  {
    n: 1,
    color: "#1a1a2e",
    title: "[SAMPLE] Evening gathering, MG Road",
    date: "2026-03-14",
    location: "MG Road, Bengaluru",
    tags: ["gathering", "evening", "street"],
    verificationStatus: "unverified",
    uploader: "sample_uploader_1",
    platform: "YouTube",
    publishedAt: "2026-03-15",
  },
  {
    n: 2,
    color: "#2e1a1a",
    title: "[SAMPLE] March passing through junction",
    date: "2026-03-16",
    location: "Town Hall junction, Bengaluru",
    tags: ["march", "junction", "daytime"],
    verificationStatus: "likely-verified",
    uploader: "sample_uploader_2",
    platform: "Twitter/X",
    publishedAt: "2026-03-16",
  },
  {
    n: 3,
    color: "#1a2e1a",
    title: "[SAMPLE] Crowd assembly near station",
    date: "2026-03-18",
    location: "Railway station forecourt, Pune",
    tags: ["crowd", "station", "assembly"],
    verificationStatus: "verified",
    uploader: "sample_uploader_3",
    platform: "YouTube",
    publishedAt: "2026-03-19",
  },
  {
    n: 4,
    color: "#2e2a1a",
    title: "[SAMPLE] Night footage, downtown intersection",
    date: "2026-03-20",
    location: "Downtown intersection, Mumbai",
    tags: ["night", "intersection", "vehicles"],
    verificationStatus: "partially-verified",
    uploader: "sample_uploader_4",
    platform: "Instagram",
    publishedAt: "2026-03-21",
  },
  {
    n: 5,
    color: "#1a2e2e",
    title: "[SAMPLE] Overhead drone pass, market street",
    date: "2026-03-22",
    location: "Market street, Ahmedabad",
    tags: ["drone", "overhead", "market"],
    verificationStatus: "context-unclear",
    uploader: "sample_uploader_5",
    platform: "YouTube",
    publishedAt: "2026-03-23",
  },
  {
    n: 6,
    color: "#2a1a2e",
    title: "[SAMPLE] Static handheld clip, campus gate",
    date: "2026-03-25",
    location: "University campus gate, Delhi",
    tags: ["campus", "handheld", "gate"],
    verificationStatus: "unverified",
    uploader: "sample_uploader_6",
    platform: "Telegram",
    publishedAt: "2026-03-25",
  },
  {
    n: 7,
    color: "#231f1f",
    title: "[SAMPLE] Wide shot, riverside promenade",
    date: "2026-03-27",
    location: "Riverside promenade, Ahmedabad",
    tags: ["riverside", "wide-shot", "daytime"],
    verificationStatus: "likely-verified",
    uploader: "sample_uploader_7",
    platform: "YouTube",
    publishedAt: "2026-03-28",
  },
  {
    n: 8,
    color: "#16213e",
    title: "[SAMPLE] Close-up pan, market entrance",
    date: "2026-03-30",
    location: "Market entrance, Pune",
    tags: ["close-up", "pan", "market"],
    verificationStatus: "unverified",
    uploader: "sample_uploader_8",
    platform: "Facebook",
    publishedAt: "2026-03-30",
  },
];

const TODAY = new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Generate clips + thumbnails
// ---------------------------------------------------------------------------

mkdirSync(VIDEOS_DIR, { recursive: true });
mkdirSync(THUMBS_DIR, { recursive: true });

function drawtextFilter() {
  const fontfilePart = WATERMARK_FONTFILE ? `fontfile=${WATERMARK_FONTFILE}:` : "";
  return `drawtext=${fontfilePart}text='SAMPLE':fontsize=96:fontcolor=white:x=(w-tw)/2:y=(h-th)/2`;
}

const generatedVideos = [];

for (const plan of SAMPLE_PLAN) {
  const id = `video-${String(plan.n).padStart(3, "0")}`;
  const videoFile = path.join(VIDEOS_DIR, `${id}.mp4`);
  const thumbFile = path.join(THUMBS_DIR, `${id}.jpg`);

  console.log(`Generating ${id} (${plan.color})...`);

  run(FFMPEG, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${plan.color}:s=720x1280:d=8`,
    "-vf",
    drawtextFilter(),
    "-c:v",
    "libx264",
    "-crf",
    "30",
    "-pix_fmt",
    "yuv420p",
    "-an",
    videoFile,
  ]);

  run(FFMPEG, [
    "-y",
    "-ss",
    "1",
    "-i",
    videoFile,
    "-frames:v",
    "1",
    "-vf",
    "scale=720:-2",
    thumbFile,
  ]);

  const { duration, width, height } = probe(videoFile);

  generatedVideos.push({
    id,
    title: plan.title,
    description:
      `Placeholder sample clip. Solid dark background with a centered "SAMPLE" watermark; ` +
      `no real footage. Stands in for a ${plan.duration ?? 8}s vertical video pending real archive content.`,
    date: plan.date,
    location: plan.location,
    tags: plan.tags,
    verificationStatus: plan.verificationStatus,
    sample: true,
    source: {
      platform: plan.platform,
      url: "https://blackdays.in/about",
      uploader: plan.uploader,
      publishedAt: plan.publishedAt,
    },
    media: {
      video: `videos/${id}.mp4`,
      thumbnail: `thumbnails/${id}.jpg`,
      duration,
      width,
      height,
    },
    archivedAt: TODAY,
  });
}

// ---------------------------------------------------------------------------
// Merge into videos.json, preserving non-sample entries, idempotently
// replacing sample ones.
// ---------------------------------------------------------------------------

function readJsonArray(file) {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf8").trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

const existingVideos = readJsonArray(VIDEOS_JSON);
const nonSampleVideos = existingVideos.filter((v) => v.sample !== true);
const mergedVideos = [...nonSampleVideos, ...generatedVideos];

writeFileSync(VIDEOS_JSON, JSON.stringify(mergedVideos, null, 2) + "\n");

// ---------------------------------------------------------------------------
// Timeline: 6-8 events referencing the sample video ids.
// ---------------------------------------------------------------------------

const SAMPLE_TIMELINE = [
  {
    time: "2026-03-14T18:30:00+05:30",
    title: "[SAMPLE] Evening gathering begins on MG Road",
    description:
      "Placeholder timeline entry. Marks the sample gathering footage captured on MG Road, Bengaluru.",
    relatedVideoIds: ["video-001"],
  },
  {
    time: "2026-03-16T11:00:00+05:30",
    title: "[SAMPLE] March reaches Town Hall junction",
    description:
      "Placeholder timeline entry. Marks the sample march footage passing through the Town Hall junction.",
    relatedVideoIds: ["video-002"],
  },
  {
    time: "2026-03-18T09:15:00+05:30",
    title: "[SAMPLE] Crowd assembles near Pune station",
    description:
      "Placeholder timeline entry. Marks the sample assembly footage near the railway station forecourt in Pune.",
    relatedVideoIds: ["video-003"],
  },
  {
    time: "2026-03-20T21:45:00+05:30",
    title: "[SAMPLE] Night footage recorded downtown",
    description:
      "Placeholder timeline entry. Marks the sample night footage from a downtown Mumbai intersection.",
    relatedVideoIds: ["video-004"],
  },
  {
    time: "2026-03-22T16:00:00+05:30",
    title: "[SAMPLE] Drone pass over Ahmedabad market street",
    description:
      "Placeholder timeline entry. Marks the sample overhead drone footage of a market street in Ahmedabad.",
    relatedVideoIds: ["video-005", "video-007"],
  },
  {
    time: "2026-03-25T08:20:00+05:30",
    title: "[SAMPLE] Handheld clip recorded at campus gate",
    description:
      "Placeholder timeline entry. Marks the sample handheld footage recorded at a Delhi university campus gate.",
    relatedVideoIds: ["video-006"],
  },
  {
    time: "2026-03-27T17:10:00+05:30",
    title: "[SAMPLE] Wide shot recorded along riverside promenade",
    description:
      "Placeholder timeline entry. Marks the sample wide-shot footage along the Ahmedabad riverside promenade.",
    relatedVideoIds: ["video-007"],
  },
  {
    time: "2026-03-30T13:05:00+05:30",
    title: "[SAMPLE] Close-up pan recorded at Pune market entrance",
    description:
      "Placeholder timeline entry. Marks the sample close-up footage recorded at a Pune market entrance.",
    relatedVideoIds: ["video-008"],
  },
];

const existingTimeline = readJsonArray(TIMELINE_JSON);
const nonSampleTimeline = existingTimeline.filter(
  (e) => !e.title || !e.title.startsWith("[SAMPLE]"),
);
const mergedTimeline = [...nonSampleTimeline, ...SAMPLE_TIMELINE];

writeFileSync(TIMELINE_JSON, JSON.stringify(mergedTimeline, null, 2) + "\n");

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\nGenerated ${generatedVideos.length} sample video entries:`);
for (const v of generatedVideos) {
  const videoPath = path.join(VIDEOS_DIR, `${v.id}.mp4`);
  const thumbPath = path.join(THUMBS_DIR, `${v.id}.jpg`);
  const videoSize = statSync(videoPath).size;
  const thumbSize = statSync(thumbPath).size;
  console.log(
    `  ${v.id}: ${v.media.width}x${v.media.height}, ${v.media.duration}s, ` +
      `${v.verificationStatus}, video=${(videoSize / 1024).toFixed(1)}KiB thumb=${(thumbSize / 1024).toFixed(1)}KiB`,
  );
}
console.log(`\nWrote ${mergedVideos.length} total entries to ${path.relative(ROOT, VIDEOS_JSON)}`);
console.log(`Wrote ${mergedTimeline.length} total entries to ${path.relative(ROOT, TIMELINE_JSON)}`);
