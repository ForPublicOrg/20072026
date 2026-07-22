# Black Days — Execution Plan

**Date:** 2026-07-21 · Goal: live at 20072026.com today.

## Phase 1 — Launch day (today)

1. **Docs** — design-spec, execution-plan, content-pipeline, verification-policy, README. ✅ once committed.
2. **Scaffold** — Astro (static) + TypeScript strict + Tailwind + `wrangler.jsonc` (Workers static assets, `dist/`). Scripts: `dev`, `build`, `deploy`.
3. **Data layer** — TS types + build-time validation for `videos.json` / `timeline.json`; `MEDIA_BASE` config.
4. **Sample content** — `scripts/generate-samples.mjs`: ~8 ffmpeg-generated placeholder clips + thumbnails + entries labeled SAMPLE, so the live site demonstrates the full experience.
5. **Site** — hero + feed (IntersectionObserver autoplay), `/video/[id]` (OG meta, related videos), `/timeline`, `/about`, 404, sitemap.
6. **Pipeline** — `scripts/collect.mjs <url>`: download → compress → thumbnail → metadata → dedupe → append to `videos.json`.
7. **Deploy** — `npm run deploy` → verify on `*.workers.dev` (feed behavior, video page OG tags via curl, timeline, mobile viewport).
8. **Domain** — attach custom domain to Worker on the already-owned `20072026.com` zone, create R2 bucket `blackdays-media`.

**Definition of done (today):** live URL serving the full experience; one real URL successfully collected through the pipeline; nameserver instructions delivered.

## Phase 2 — First real content (this week)

- Collect real public media via the pipeline; review each entry's metadata and description.
- Move media to R2 (`media.20072026.com`), flip `MEDIA_BASE`, delete sample entries.
- Apply verification policy to each item; write the real timeline from corroborated sources.
- Client-side filtering: tag, location, date, platform, verification status (small static index, no backend).

## Phase 3 — Depth

- Full-text client-side search (prebuilt lightweight index, e.g. Pagefind).
- Collections (curated groupings: police response, speeches, marches, interviews, media coverage).
- Statistics block (counts, total duration, timeline coverage) — computed at build time.
- WebM renditions where bandwidth savings matter.

## Phase 4 — Later

- Interactive map of capture locations.
- Smarter related-videos (time + location + tags scoring).
- Duplicate detection across sources (perceptual hashing).

## Operating principles

- Static always; build-time over runtime; JSON over databases; minimal JS.
- One maintainer must be able to run everything.
- Never publish an entry without source attribution and a verification status.
