# Black Days — Execution Plan

Current status and forward roadmap. For the fixed, already-built architecture, see `design-spec.md`.

## Done

- Static site (Astro) live on Cloudflare Workers static assets, custom domain `20072026.com`, CI-driven staging/production deploys (see `CLAUDE.md` "Deploy model").
- Data pipeline: `scripts/collect.mjs`/`collect-batch.mjs` collect real public footage; 94 entries currently in `src/data/videos.json`, all fully filled in (no `TODO` placeholders, no sample entries).
- R2 cutover complete: real media served from `media.20072026.com`, `MEDIA_BASE` points there, no more site-asset media.
- Timeline hand-researched and cited: 39 events, each with at least one source citation, some with official statements and/or a photograph (`src/data/timeline.json`, `docs/content-pipeline.md`).
- Corrections/takedown flow live end-to-end (`/takedown` → `POST /api/takedown` → D1 `TAKEDOWNS`).
- Public "submit a video" flow live end-to-end (home page form → `POST /api/submit-video` + `PUT /api/upload/:id` → D1 `SUBMISSIONS` + R2 `UPLOADS`), with `scripts/admin-requests.mjs` for triage.
- Related-video scoring on `/video/[id]` (shared tags + date + location).
- Three-layer test suite (unit/integration/e2e) gating both deploy environments in CI.

## Open

- **Client-side filtering**: by tag, location, date, platform, verification status. Not yet built — still a static per-page render with no filter UI.
- **Full-text client-side search** (e.g. a prebuilt Pagefind index).
- **Collections**: curated groupings (police response, speeches, marches, interviews, media coverage).
- **Statistics block**: counts, total duration, timeline coverage, computed at build time.
- **WebM renditions** where bandwidth savings matter (currently MP4/H.264 only).
- **Interactive map** of capture locations.
- **Duplicate detection** across sources (perceptual hashing) — currently relies on `source.url` dedup only (`collect.mjs`'s duplicate check).
- **Turnstile** on the takedown and submit-video forms — current spam defense is honeypot + rate caps only (see `design-spec.md` §8/§9); this is the intended next step and not yet implemented.

## Operating principles

- Static always; build-time over runtime; JSON over databases; minimal JS.
- One maintainer must be able to run everything.
- Never publish an entry without source attribution and a verification status.
