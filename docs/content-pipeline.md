# Black Days — Content Pipeline

How media gets from a public URL into the archive. Everything runs locally; nothing here is deployed.

## Prerequisites

```sh
brew install yt-dlp ffmpeg
```

Both scripts must check for `yt-dlp` and `ffmpeg` on PATH at startup and exit with the brew hint above if missing.

## Adding a video: `node scripts/collect.mjs <public-url>`

Pipeline stages, in order:

1. **Duplicate check** — if `source.url` already exists in `src/data/videos.json`, abort with a message naming the existing entry id.
2. **Download** — `yt-dlp -f "bv*[height<=1080]+ba/b[height<=1080]" --no-playlist -o <tmp>/raw.%(ext)s <url>`. Also capture metadata: `yt-dlp --dump-json` → uploader, title, upload date, platform (from extractor key).
3. **Normalize id** — next sequential id: `video-NNN` (zero-padded, max existing + 1).
4. **Compress for web** — `ffmpeg -i raw -c:v libx264 -preset slow -crf 26 -vf "scale='min(720,iw)':-2" -c:a aac -b:a 96k -movflags +faststart media/videos/video-NNN.mp4`. Target: playable everywhere, small enough for mobile data.
5. **Thumbnail** — `ffmpeg -ss 1 -i video-NNN.mp4 -frames:v 1 -vf "scale=720:-2" media/thumbnails/video-NNN.jpg`.
6. **Probe** — `ffprobe -v quiet -print_format json -show_format -show_streams` → duration (s, rounded), width, height.
7. **Append entry** — build the entry (schema in `design-spec.md` §5) with:
   - `verificationStatus: "unverified"` — always; upgrades are manual (see `verification-policy.md`). Recorded regardless of whether anything currently displays it — as of 2026-07-21 nothing in the UI renders this field (see `verification-policy.md` "Display rules"), but it is still required and still validated.
   - `title`/`uploader`/`publishedAt` prefilled from yt-dlp metadata; `description`, `date`, `location`, `tags` left as `"TODO"` placeholders for human editing
   - `archivedAt`: today (ISO)
   - no `sample` field
   Validate against the schema, then write `videos.json` (pretty-printed, 2-space).
8. **Print summary** — id, file sizes, duration, and a reminder to fill in the TODO fields before deploying.

The raw download is kept in `archive-originals/` (git-ignored) as the archival copy; only the compressed version is served.

**Post-R2-cutover caveat:** `collect.mjs` still writes to `public/media/videos|thumbnails/`, which predates the 2026-07-21 R2 cutover and is no longer served (see "Media base switch" below). Files that land there need to be moved to `/media/videos|thumbnails/` and pushed to the `blackdays-media` bucket by hand:
```sh
wrangler r2 object put blackdays-media/videos/video-NNN.mp4 --file media/videos/video-NNN.mp4 --remote
wrangler r2 object put blackdays-media/thumbnails/video-NNN.jpg --file media/thumbnails/video-NNN.jpg --remote
```
`collect.mjs` itself is deliberately not touched to fix this (see the hard rules in `collect-batch.mjs`) — it's a known gap, not a design choice.

## Adding many videos at once: `node scripts/collect-batch.mjs <csv-path>`

Wraps `collect.mjs`, one child process per URL, strictly serial (never concurrent — see the hard rules at the top of the script). Takes a CSV with columns **Link, Status, VideoId, Notes**; this file (e.g. `20072026 - Sheet1.csv` at the repo root) is both the input queue and the durable status log — Raj appends new links to the same file over time, leaving `Status` blank on new rows.

`Status` per row:
- **blank** — never attempted; this run will try it.
- **failed** — a previous run tried and didn't get a video; this run retries it. Used for both a real technical hiccup (soft-walled request, transient empty response) and "not attempted yet in a way that stuck" — anything that might still work.
- **ignored** — terminal, never retried automatically. Set this (by hand, or by a session that investigated why a link won't work) when the content is genuinely unusable: audience/age-restricted, no video in the post, or out of scope for the archive (e.g. stock footage from an unrelated era, wrongly included in a handpicked batch). Flip back to blank to force a retry.
- **published** — already in `videos.json`; `VideoId` names the entry. Terminal, skipped.

The script rewrites the CSV in place after every single attempt (not just at the end), so an interrupted run leaves accurate state for the next one. It keeps the original script's safety valve (aborts if the first 3 attempts in a row all fail — likely an IP-level soft wall) and its politeness pacing (20–40s between requests, 60–90s before a retry pass over rows still `failed`) — do not tighten these; recon showed roughly a third of Instagram requests get silently soft-walled otherwise.

New videos this script collects still land in `public/media/` per the caveat above and need the same manual R2 upload step before they're actually live.

## Timeline data

Unlike video entries, `src/data/timeline.json` is not produced by a script — it is hand-researched and hand-written, then validated at build time by `src/lib/schema.ts`. **As of 2026-07-21 (commit `b8f0fdc`), the timeline was rewritten from research** rather than from whatever the archive happened to hold: it now has 14 events running from the Chief Justice's remark in the Supreme Court on 15 May 2026 through the march on Parliament and its aftermath on 21 July 2026.

Each event may carry an optional `sources` array — `{ title, url }` citations to the reporting it is drawn from (Al Jazeera, NPR, Wikipedia for the current set). This is required editorial discipline going forward for any claim the timeline makes about events this archive did not itself witness or film: cite the reporting, don't assert it as this site's own finding. `sources`, when present, is validated (non-empty `title`, absolute `http(s)` `url` per entry) — a malformed citation fails the build. See `docs/design-spec.md` §5 for the exact shape.

`time` is a **date-only** ISO string (`"2026-05-15"`), never a timestamp — there has never been a sourced clock time for any of these events, and none should be invented. `TimelineEvent.astro` renders it with `timeZone: "UTC"` explicitly for this reason (a date-only string parses as UTC midnight; without pinning the timezone, a reader west of Greenwich would see the previous day).

## Sample data: `node scripts/generate-samples.mjs`

Generates 8 placeholder video entries (plus its own placeholder timeline entries) so the site can demonstrate the full experience before real content exists. **As of 2026-07-21, the live archive holds no sample entries** — the original eight placeholder videos and their media were deleted once real footage existed to replace them (`video-009`…`video-013` are the five real entries now in `videos.json`). The generator script is unchanged and still works exactly as described below; it exists for re-demoing the pipeline/layout on an otherwise-empty archive, not as something that runs alongside real content today.

**Caveat carried over, not introduced by this change:** `TimelineEvent` (`src/lib/schema.ts`) has no `sample` boolean — only `VideoEntry` does. If `generate-samples.mjs` is run against the current, real, researched `timeline.json`, its placeholder timeline entries merge in with no schema-level marker distinguishing them from the real 14, and nothing currently filters them back out. Re-running the sample generator today would require manually removing the placeholder timeline entries afterward. Flagging this here since it wasn't a live risk before real timeline content existed to contaminate.

- Clips: `ffmpeg -f lavfi -i "color=c=<dark color>:s=720x1280:d=8" -vf "drawtext=text='SAMPLE':fontsize=96:fontcolor=white:x=(w-tw)/2:y=(h-th)/2" -c:v libx264 -crf 30 -pix_fmt yuv420p` — 8s, distinct dark colors, big "SAMPLE" watermark. No audio track.
- Thumbnails extracted from frame 1 as in the main pipeline.
- Entries: varied realistic-shaped metadata (different dates/times, locations, tags, all five verification statuses represented at least once), every title prefixed `[SAMPLE]`, `"sample": true`, `source.url` pointing at `https://blackdays.in/about` (not a fake external link).
- Output to `public/media/{videos,thumbnails}/` and `src/data/videos.json` + a matching sample `timeline.json` (6–8 events referencing the sample ids).

Sample media lives in the site's own assets (`public/media/`), so day 1 needs no R2. Real media later goes to R2 and `MEDIA_BASE` flips (see below).

## Media base switch

`src/config.ts` exports `MEDIA_BASE`:
- Day 1: `"/media/"` (served from `public/media/`)
- After R2 cutover: `"https://media.blackdays.in/"`

All `media.video` / `media.thumbnail` paths in JSON are relative; components join them with `MEDIA_BASE`. Cutover = upload files to R2 bucket `blackdays-media`, change one constant, delete `public/media/`, redeploy.

## Editorial rules

- Never strip attribution. `source.url`, `uploader`, `platform` are required fields.
- Descriptions state what is visible in the footage, not conclusions ("crowd moves down MG Road" not "police brutalize protesters").
- Respect platform terms of service; only archive publicly available material.
- Fill every `TODO` field before deploying — the build validation must reject entries containing `"TODO"`.
- Prioritize participant footage over media-house coverage when a choice exists — this is a record of what people who were there filmed and posted, not a rebroadcast of news coverage of them.
- If a correction or takedown request comes in, it now arrives through `/takedown/` → D1, not email (see `docs/design-spec.md` §12). Read pending requests with:
  ```sh
  npx wrangler d1 execute blackdays-takedowns --remote --command "SELECT * FROM takedown_requests ORDER BY created_at DESC"
  ```
