#!/usr/bin/env node
// Shared ffmpeg/ffprobe helpers for getting video into the archive. Used by
// scripts/collect.mjs (URL-sourced ingestion, via yt-dlp) and
// scripts/lib/upload-ingest.mjs (raw-upload-sourced ingestion, from a file
// already on disk) so both pipelines transcode/thumbnail/probe identically.
//
// run() throws rather than exiting: it's called from admin-tui.mjs's
// in-process ingestion pipeline, where a process.exit would kill the whole
// interactive session. Callers that want the old "print and exit" CLI
// behavior (collect.mjs) catch at their own top level.

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";

export function commandExists(cmd, versionArgs = ["-version"]) {
  const res = spawnSync(cmd, versionArgs);
  return !res.error && res.status === 0;
}

export function run(binary, args, opts = {}) {
  const res = spawnSync(binary, args, { encoding: "utf8", ...opts });
  if (res.status !== 0) {
    throw new Error(
      `Command failed: ${binary} ${args.join(" ")}\n${res.stderr || res.stdout || "(no output)"}`,
    );
  }
  return res;
}

export function probe(file) {
  const res = run("ffprobe", [
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
  const audioStream = data.streams.find((s) => s.codec_type === "audio");
  const duration = Math.round(Number(data.format?.duration ?? videoStream?.duration ?? 0));
  return {
    duration,
    width: Number(videoStream.width),
    height: Number(videoStream.height),
    vcodec: videoStream?.codec_name ?? null,
    acodec: audioStream?.codec_name ?? null,
    hasAudio: Boolean(audioStream),
  };
}

export function humanSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)}MiB`;
  return `${(bytes / 1024).toFixed(1)}KiB`;
}

// Remux (no re-encode) sourceFile -> outFile, matching the source's video
// stream exactly; only audio may be transcoded to AAC if it isn't already.
export function remux(sourceFile, outFile, sourceProbe) {
  const audioArgs = !sourceProbe.hasAudio
    ? ["-an"]
    : sourceProbe.acodec === "aac"
      ? ["-c:a", "copy"]
      : ["-c:a", "aac", "-b:a", "96k"];
  run("ffmpeg", [
    "-y",
    "-i",
    sourceFile,
    "-map_metadata",
    "-1",
    "-c:v",
    "copy",
    ...audioArgs,
    "-movflags",
    "+faststart",
    outFile,
  ]);
}

export function reencode(sourceFile, outFile) {
  run("ffmpeg", [
    "-y",
    "-i",
    sourceFile,
    "-map_metadata",
    "-1",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "26",
    "-vf",
    "scale='min(720,iw)':-2",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    "-movflags",
    "+faststart",
    outFile,
  ]);
}

export function generateThumbnail(videoFile, thumbFile) {
  run("ffmpeg", [
    "-y",
    "-ss",
    "1",
    "-i",
    videoFile,
    "-frames:v",
    "1",
    "-vf",
    "scale=720:-2",
    "-map_metadata",
    "-1",
    thumbFile,
  ]);
}

// Social platforms (Instagram, X) already serve hard-compressed H.264 sized
// for mobile. Re-encoding those at crf 26 targets *higher* quality than the
// source, which inflates the file without adding information — one 1.92MiB
// reel came out at 8.88MiB. So remux when the source is already web-ready,
// and only re-encode when it actually buys something. Re-encoded output
// that ends up larger than the source is discarded in favour of a remux.
//
// Pure — does not print anything, so callers with different UX needs
// (collect.mjs's CLI messages vs admin-tui.mjs's status line) decide what
// to show based on the returned `method`.
export function transcodeForWeb(sourceFile, outFile) {
  const sourceProbe = probe(sourceFile);
  const sourceSize = statSync(sourceFile).size;
  const alreadyWebReady = sourceProbe.vcodec === "h264" && sourceProbe.width <= 720;

  if (alreadyWebReady) {
    remux(sourceFile, outFile, sourceProbe);
    return { sourceProbe, sourceSize, method: "remux" };
  }

  reencode(sourceFile, outFile);
  if (statSync(outFile).size > sourceSize && sourceProbe.vcodec === "h264") {
    remux(sourceFile, outFile, sourceProbe);
    return { sourceProbe, sourceSize, method: "reencode-fallback-remux" };
  }
  return { sourceProbe, sourceSize, method: "reencode" };
}
