# Black Days — Content Pipeline

How media gets from a public URL — or a public submission — into the archive. Everything in this doc runs locally; nothing here is deployed.

## Prerequisites

```sh
brew install yt-dlp ffmpeg
```

`collect.mjs` and `collect-batch.mjs` both check for `yt-dlp` and `ffmpeg` on PATH at startup and exit with the brew hint above if missing.

## Adding a video: `node scripts/collect.mjs <public-url>`

Pipeline stages, in order:

1. **Duplicate check** — if `source.url` already exists in `src/data/videos.json`, abort with a message naming the existing entry id.
2. **Download** — `yt-dlp -f "bv*[height<=1080]+ba/b[height<=1080]" --no-playlist -o <tmp>/raw.%(ext)s <url>`. Also captures metadata via `yt-dlp --dump-json`: uploader, title, upload date, platform (from extractor key).
3. **Normalize id** — next sequential id: `video-NNN` (zero-padded, max existing + 1).
4. **Compress for web** — `ffmpeg -i raw -c:v libx264 -preset slow -crf 26 -vf "scale='min(720,iw)':-2" -c:a aac -b:a 96k -movflags +faststart media/videos/video-NNN.mp4`.
5. **Thumbnail** — `ffmpeg -ss 1 -i video-NNN.mp4 -frames:v 1 -vf "scale=720:-2" media/thumbnails/video-NNN.jpg`.
6. **Probe** — `ffprobe -v quiet -print_format json -show_format -show_streams` → duration (s, rounded), width, height.
7. **Append entry** — build the entry (schema in `design-spec.md` §4) with `verificationStatus: "unverified"` always (upgrades are manual, see `verification-policy.md`); `title`/`uploader`/`publishedAt` prefilled from yt-dlp metadata; `description`, `date`, `location`, `tags`, `footageOrigin` left as `"TODO"` placeholders for human editing (`footageOrigin` — `"participant"` or `"media"` — drives feed ordering, see "Editorial rules" below); `archivedAt` set to today (ISO); no `sample` field. Validated against the schema, then written to `videos.json` (pretty-printed, 2-space).
8. **Print summary** — id, file sizes, duration, and a reminder to fill in the `TODO` fields before deploying.

The raw download is kept in `archive-originals/` (git-ignored) as the archival copy; only the compressed version is served.

**Media-base caveat:** `collect.mjs` still writes to `public/media/videos|thumbnails/`, which predates the R2 cutover and is no longer served. Files that land there need to be moved to R2 by hand:
```sh
wrangler r2 object put blackdays-media/videos/video-NNN.mp4 --file media/videos/video-NNN.mp4 --remote
wrangler r2 object put blackdays-media/thumbnails/video-NNN.jpg --file media/thumbnails/video-NNN.jpg --remote
```
This is a known gap in `collect.mjs`, not a design choice — see the hard rules at the top of `collect-batch.mjs` for why it isn't patched there instead.

## Adding many videos at once: `node scripts/collect-batch.mjs <csv-path>`

Wraps `collect.mjs`, one child process per URL, strictly serial (never concurrent — id assignment races otherwise). Takes a CSV with columns **Link, Status, VideoId, Notes**; the repo-root file `20072026 - Sheet1.csv` is both the input queue and the durable status log — new links get appended to it over time with `Status` left blank.

`Status` per row:
- **blank** — never attempted; this run will try it.
- **failed** — a previous run tried and didn't get a video; retried on the next run.
- **ignored** — terminal, never retried automatically (audience/age-restricted, no video in the post, out of scope). Flip back to blank to force a retry.
- **published** — already in `videos.json`; `VideoId` names the entry. Terminal, skipped.

The script rewrites the CSV in place after every attempt, so an interrupted run leaves accurate state for the next one. It has a safety valve (aborts after 3 consecutive failures — likely an IP-level soft wall) and deliberately slow pacing (20–40s between requests, 60–90s before retrying rows still `failed`) — a third of requests to some platforms get silently soft-walled otherwise, so don't tighten these. It also normalizes Instagram URLs (strips tracking params) before the duplicate check.

New videos this script collects still land in `public/media/` per the caveat above and need the same manual R2 upload step before they're live.

## Timeline data

Unlike video entries, `src/data/timeline.json` is hand-researched and hand-written, then validated at build time by `src/lib/schema.ts` — currently 39 events. Each event may carry an optional `sources` array (`{title, url}` citations to the reporting it draws from), an optional `statements` array (quotes attributed to named officials, each with its own source citation), and an optional `image`. This is required editorial discipline for any claim the timeline makes about events this archive did not itself witness or film: cite the reporting, don't assert it as this site's own finding. All three are validated when present — a malformed citation, quote, or image fails the build. See `design-spec.md` §4 for the exact shape.

`time` is a **date-only** ISO string (e.g. `"2026-05-15"`), never a timestamp — there has never been a sourced clock time for any of these events, and none should be invented. `TimelineEvent.astro` renders it with `timeZone: "UTC"` explicitly (a date-only string parses as UTC midnight; without pinning the timezone, a reader west of Greenwich would see the previous day).

## Sample data: `node scripts/generate-samples.mjs`

Generates 8 placeholder video entries (plus placeholder timeline entries) so the site can demonstrate the full experience on an otherwise-empty archive. No entry in the live `videos.json` currently sets `sample: true` — the archive holds real, collected footage only — but the script is unchanged and still works for re-demoing the pipeline/layout.

**Caveat:** `TimelineEvent` has no `sample` boolean — only `VideoEntry` does. Running this script against the current, real, researched `timeline.json` would merge its placeholder timeline entries in with no schema-level marker distinguishing them from the real 39, and nothing currently filters them back out; removing them afterward would be manual.

- Clips: `ffmpeg -f lavfi -i "color=c=<dark color>:s=720x1280:d=8" -vf "drawtext=text='SAMPLE':fontsize=96:fontcolor=white:x=(w-tw)/2:y=(h-th)/2" -c:v libx264 -crf 30 -pix_fmt yuv420p` — 8s, distinct dark colors, big "SAMPLE" watermark, no audio.
- Thumbnails extracted from frame 1 as in the main pipeline.
- Entries: varied realistic-shaped metadata, every title prefixed `[SAMPLE]`, `"sample": true`, `source.url` pointing at `https://20072026.com/about`.
- Output to `public/media/{videos,thumbnails}/` plus `src/data/videos.json` and a matching sample `timeline.json`.

## Enriching entries: `node scripts/enrich.mjs propose|apply`

A two-phase, human-in-the-loop tool for filling in editorial fields (`date`, `description`, `tags`, `location`, `footageOrigin`) on entries that came out of `collect.mjs` with `TODO` placeholders — or for revisiting fields on existing entries.

- **`propose [--out <path>]`** — read-only scan of `videos.json`; computes a per-field proposal (`{status, value, confidence, rationale}`, status one of `accepted`/`proposed`/`blocked`/`skipped`) and writes a review file. Requires `BLACKDAYS_SCRATCH_DIR` to be set and refuses to write inside the repo. Only `date` can be auto-`accepted` (copied straight from `source.publishedAt`); every other field always requires human sign-off before `apply` will touch it.
- **`apply --review <path>`** — a dumb literal writer: copies only the fields whose review-file status is `"accepted"` into `videos.json`. It never re-derives anything itself — all judgment happens in the human-reviewed file between `propose` and `apply`.

This propose/apply shape is the template for adding future editorial-judgment fields without inventing new tooling each time.

## Media base switch

`src/config.ts` exports `MEDIA_BASE`, currently `"https://media.20072026.com/"`. All `media.video`/`media.thumbnail` paths in JSON are relative; components join them with `MEDIA_BASE` at render time — a future switch is one constant change, not a data rewrite.

## Submitted videos: `node scripts/admin-requests.mjs`

The home page's public "submit a video" form (`design-spec.md` §8) writes into D1 (`SUBMISSIONS.video_submissions`) and, for raw uploads, R2 (`UPLOADS`) — a private inbox, same as takedown requests. `scripts/admin-requests.mjs` is the CLI for triaging both inboxes, authenticated via the operator's own `wrangler login` session:

```sh
node scripts/admin-requests.mjs list     --type takedown|video [--status <s>] [--format table|csv|json] [--env staging]
node scripts/admin-requests.mjs update   --type takedown|video --id <n> --status <new|reviewing|approved|rejected|done> [--env staging]
node scripts/admin-requests.mjs download --id <n> --out <path> [--env staging]   # video uploads only, pulls from R2
```

Approving a link-mode video submission (`update --type video --status approved`) appends its URL to the master collection CSV (`20072026 - Sheet1.csv`, deduped against existing rows) with a note identifying which submission it came from — this is what feeds a web-submitted link into the next `collect-batch.mjs` run. Approving an upload-mode submission prints the matching `download` command so the raw file can be pulled out of `UPLOADS` for review.

## Editorial rules

- Never strip attribution. `source.url`, `uploader`, `platform` are required fields.
- Descriptions state what is visible in the footage, not conclusions ("crowd moves down MG Road" not "police brutalize protesters").
- Respect platform terms of service; only archive publicly available material.
- Fill every `TODO` field before deploying — build validation rejects any entry containing the literal string `"TODO"` (unless `sample: true`).
- Classify every entry's `footageOrigin` as `"participant"` (raw footage filmed and posted by someone who was there) or `"media"` (media outlets, political parties, influencer/channel accounts, edited compilations, commentary/reaction content) — an enforced, validated field that determines feed order, participant footage surfacing first (`src/pages/feed.astro`, `src/scripts/feed.ts`). `scripts/enrich.mjs`'s `deriveFootageOrigin` heuristic is a starting point, never a final answer — every value needs a human look. The same `derive<Field>()` recipe in `enrich.mjs` is the template for adding future editorial-judgment fields without inventing new tooling.
- If a correction or takedown request comes in, it arrives through `/takedown/` → D1, not email. Read pending requests with `node scripts/admin-requests.mjs list --type takedown` or the raw `wrangler d1 execute` command in `CLAUDE.md`.
