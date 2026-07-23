# Black Days — Design Specification

**Domain:** 20072026.com

## 1. What this is

A static archive documenting publicly available videos, photos, and reporting related to a specific protest event. The objective is **preservation, discoverability, and historical documentation** — not commentary. The site preserves attribution to original sources and avoids editorializing. Verification status is recorded internally per entry (see `verification-policy.md`) but is not displayed anywhere in the UI — nothing in the archive has been independently verified, and the site says so plainly on `/about`.

This spec refines `initial-doc.md`, which remains only as a record of the original idea; where the two differ, this document wins.

## 2. Architecture

```
Collection (yt-dlp + ffmpeg, local)  ──┐
Public "submit a video" form ──────────┼──► src/data/videos.json ─┐
                                        │    src/data/timeline.json ┤
                                        │                           ▼
                                        │              validated at build time
                                        │              (src/lib/schema.ts)
                                        │                           │
                                        │                           ▼
                                        │              Astro static build (dist/)
                                        │                           │
                                        │                           ▼
                                        │         Cloudflare Worker (src/worker.ts)
                                        │      static assets + POST /api/takedown
                                        │           POST /api/submit-video
                                        └──────────►  PUT /api/upload/:id
                                                              │
                                            D1 (TAKEDOWNS, SUBMISSIONS)
                                            R2 (UPLOADS — pending, private)
                                            R2 (blackdays-media — public, reference footage)
```

- **Fully static page output.** No server-rendered pages, no page-level database reads. `output: 'static'` in `astro.config.mjs`.
- **A narrow Worker exists alongside the static build**, solely to give three POST/PUT endpoints somewhere to land (takedown requests, public video submissions, raw file uploads). Because `wrangler.jsonc` configures `assets` alongside `main`, Cloudflare serves matching static files without invoking the Worker at all — ordinary page loads cost nothing extra.
- **Build-time page generation.** Every video gets a pre-rendered `/video/:id` page with a unique `<title>`, description, and OG/Twitter meta pointing at its thumbnail — this is what makes shared links render rich previews on WhatsApp/X/Telegram.
- **Build-time validation.** A malformed `videos.json`/`timeline.json` entry fails the build, never the live site (`src/lib/schema.ts`).
- **Minimal client JavaScript.** Vanilla TS for feed playback/scrubbing (`src/scripts/feed.ts`), the landing page's scroll-reveal and submit-video form (inline in `index.astro`), and progressive enhancement of the takedown form. No framework runtime ships to the client.

## 3. Technology

- **Astro** (static output) + **TypeScript** (strict) + **Tailwind CSS 4** (via `@tailwindcss/vite`)
- **Cloudflare Workers**: static assets (`ASSETS` binding) + `src/worker.ts` for `/api/*`, deployed via `wrangler deploy` (CI-driven — see `CLAUDE.md` "Deploy model")
- **Cloudflare D1**: `TAKEDOWNS` (corrections/takedowns), `SUBMISSIONS` (public video submissions)
- **Cloudflare R2**: `blackdays-media` (public reference footage, served at `media.20072026.com`, not a Worker binding) and `UPLOADS` (private, pending raw uploads from the submit-video form)
- **@astrojs/sitemap** for sitemap generation
- Collection tooling (local only, not part of the deploy): **yt-dlp**, **ffmpeg/ffprobe**

`src/config.ts`:
```ts
export const SITE_NAME = "20.07.2026";
export const SITE_URL = "https://20072026.com";
export const MEDIA_BASE = "https://media.20072026.com/";
```
No `CONTACT_EMAIL` constant, by design — corrections and video submissions go through `/takedown/` and the home page's submit form, both backed by D1, not a published personal address.

## 4. Data model

`src/data/videos.json` — array of `VideoEntry` (types + validation in `src/lib/schema.ts`):

```jsonc
{
  "id": "video-009",              // stable slug, never reused, matches /^video-\d{3}$/
  "title": "…",
  "description": "…",             // factual, no editorializing
  "date": "2026-07-20",           // date of the event depicted (ISO)
  "location": "…",                // optional — omitted, never guessed, when not geo-verified
  "tags": ["…"],                  // defaults to [] when not yet tagged
  "verificationStatus": "unverified", // see verification-policy.md
  "footageOrigin": "participant",  // "participant" (raw, filmed by someone who was there) or
                                    // "media" (outlet/party/influencer/channel content) — drives
                                    // feed ordering, see §8 and content-pipeline.md "Editorial rules"
  "sample": true,                  // present + true ONLY for placeholder entries
  "source": {
    "platform": "YouTube",
    "url": "…",                   // original public URL — always preserved
    "uploader": "…",
    "publishedAt": "…"
  },
  "media": {
    "video": "videos/video-009.mp4",      // path relative to MEDIA_BASE
    "thumbnail": "thumbnails/video-009.jpg",
    "duration": 42,                // seconds, from ffprobe
    "width": 720,
    "height": 1280
  },
  "archivedAt": "2026-07-21"
}
```

Currently 94 entries (ids `video-009`–`video-104`, non-contiguous), zero of them `sample: true`, zero literal `"TODO"` fields. 57 are `footageOrigin: "participant"`, 37 are `"media"`.

`src/data/timeline.json` — array of `TimelineEvent`:

```jsonc
{
  "time": "2026-05-15",           // date-only ISO string — no clock time; rendered with timeZone: "UTC"
  "title": "…",
  "description": "…",
  "relatedVideoIds": [],          // must reference existing video ids — validated at build time
  "sources": [                    // {title, url} citations to the reporting the entry draws from
    { "title": "…", "url": "https://…" }
  ],
  "statements": [                 // optional — what an official actually said, tied to this event
    {
      "speaker": "…", "role": "…", "kind": "press",  // kind: tweet|address|press|parliament|court|interview
      "date": "…", "quote": "…", "context": "…",       // quote is verbatim, as quoted by the source
      "source": { "title": "…", "url": "https://…" }
    }
  ],
  "image": {                      // optional — a photograph attached to this event
    "src": "/timeline/…",         // must be a committed path under /timeline/
    "alt": "…", "caption": "…", "credit": "…",
    "sourceUrl": "https://…",     // where the original lives
    "width": 0, "height": 0
  }
}
```

Currently 39 events, `2026-05-15` → `2026-07-22`, every event carries at least one `sources` citation. `sources`/`statements`/`image` are all optional but validated when present: a malformed citation, quote, or image fails the build rather than silently vanishing from the page — an event whose sourcing quietly disappeared is worse than one that never claimed any.

**`MEDIA_BASE`**: single constant in `src/config.ts`, currently `https://media.20072026.com/`. All `media.video`/`media.thumbnail` paths in JSON are relative to it; components join them at render time. Data files never encode an absolute media host.

**Sample entries:** the `sample` field is fully supported (schema, the `/video/[id]` placeholder banner, `scripts/generate-samples.mjs`) but no current entry sets it — the archive holds real, collected footage only.

## 5. Verification levels

Five levels, recorded on every entry, defined in full in `verification-policy.md`:

`verified` · `likely-verified` · `partially-verified` · `unverified` · `context-unclear`

Everything entering via the pipeline starts as `unverified`; upgrades are manual, deliberate edits to `videos.json`. **Not currently rendered anywhere in the UI.** `src/components/VerificationBadge.astro` is fully implemented (five-color set, WCAG-contrast-checked) but is not imported by any page or component — it exists on disk so that reinstating a badge, or building some other verification UI, is a display change later rather than a re-litigation of every entry's status now.

## 6. Pages

| Route | Content |
|---|---|
| `/` | Landing page. Full-viewport (`100svh`) illustrated poster hero (labelled "Illustration. Not documentary footage" directly on the scrim) with a "Show me proof" CTA to `/feed`, no visible header/footer on this route. Below the fold, a scroll-revealed storyline (what happened, what the archive is, build-time-computed video/timeline counts, a verification note linking to `/about`) followed by the **"Submit a video" form** — see §8. |
| `/feed` | Full-viewport, reels/Instagram-main-feed-style vertical snap-scroll feed. One `VideoCard` per entry, sorted at build time into `footageOrigin` tiers (participant footage first); reshuffled client-side within each tier on every load/navigation (`src/scripts/feed.ts`). See §7. |
| `/video/[id]` | `getStaticPaths()` over every video. Player (`controls`, direct `src`, no observer), full metadata (event date, location, platform, uploader, original link `rel="noopener nofollow"`, archived date, duration), description, tags. No verification badge (§5). Shows a "Sample — placeholder entry" banner when `video.sample` is true (no current entry sets it). **Related videos**: other entries scored `2×(shared tags) + (same date ? 1 : 0) + (same location ? 1 : 0)`, top 4 with score > 0. OG: title = video title, image = absolute thumbnail URL, `og:type=video.other`. |
| `/timeline` | Chronological event list; each event links to its related videos and, when present, the `sources`/`statements`/`image` it carries (`TimelineEvent.astro`). |
| `/about` | Mission, where the material comes from (participant footage over media-house coverage, attribution always kept), an explicit statement that nothing has been independently verified, a link to `/timeline/`, and a "Make a request" link to `/takedown/`. |
| `/takedown` | Corrections/takedown form, posts to `/api/takedown` (`src/worker.ts`), stores rows in D1 `TAKEDOWNS`. Works with JavaScript disabled — see §9. |
| `404` | Real 404 page (no SPA fallback). |

Navigation is a persistent app shell (`src/layouts/Base.astro`), not a page-by-page header: an icon-only bottom tab bar (Home · Feed · Timeline · About) on mobile, a fixed left sidebar at `≥768px`, active tab shown by a filled vs. outline glyph plus `aria-current`. `Base.astro` props: `title`, `description`, `ogImage?`, `ogType?`, `canonical?`, `fullBleed?` (removes page padding/document scroll so a page like `/feed` owns its own snap-scrolling), `hideHeader?`, `overlayNav?`, `hideFooter?`. Astro's `<ClientRouter />` morphs between routes instead of a full reload, respecting `prefers-reduced-motion`.

## 7. Feed behavior (`/feed`)

- Each card is an Instagram-main-feed-style post (`VideoCard.astro`): post header (avatar monogram from `source.uploader`'s first letter, uploader handle, location), the video as its own letterboxed block, a meta row, a caption block — never metadata burned over the footage.
- Meta row's CTA is the platform name itself — "View on {platform} ↗" — linking straight to `video.source.url` (`target="_blank" rel="noopener noreferrer"`), so credibility routes to the person who filmed it, not to this site's own page.
- The "more" control is a `<button>`, not a link: expands the caption in place (`.is-expanded`, capped to ~30% of the card's own height with internal scroll), only shown once script measures the 2-line clamp is actually clipping.
- The progress bar is a real scrubber: `role="slider"` with the `aria-value*` triad, click-to-seek, pointer-drag-to-scrub, arrow-key nudging (`ArrowLeft`/`ArrowRight`/`ArrowUp`/`ArrowDown` ±5s, `Home`/`End`). Visible bar stays a thin 3px; the hit area is padded to 20px tall.
- **IntersectionObserver** (threshold 0.6): a card ≥60% visible → muted autoplay; below that → pause (resume position kept, nothing reset).
- `preload="none"`, poster = thumbnail. Video `src` is attached only for the current and next card, detached beyond that — the archive can grow to thousands of entries without the feed degrading.
- **Ordering**: two-tier priority by `footageOrigin` — `"participant"` entries first, then `"media"` entries, each tier independently shuffled and never interleaved. `feed.astro`'s build-time sort (participant tier first, each tier by date desc then id desc) is the deterministic no-JS baseline; `shuffleFeedOrder()` re-randomizes within each tier (Fisher-Yates per tier) on every load/navigation, reading each card's `data-footage-origin` attribute (set by `VideoCard.astro`). See `content-pipeline.md` "Editorial rules".
- Tap/click toggles sound (persists across cards once unmuted). Keyboard: cards focusable, space/enter toggles play, arrow up/down moves focus and snap-scrolls to the adjacent card.
- `prefers-reduced-motion: reduce` → never autoplay; native `controls` shown instead.

## 8. Submit-a-video

A public "submit a video" form lives embedded in `src/pages/index.astro` (not a separate route), letting a visitor point the archive at footage rather than the maintainer having to find it.

- Mode toggle: **link** (a public URL) or **upload** (a raw file, up to 250MB). Optional event date, description, contact; a honeypot field (`website`, off-screen CSS, not `display:none`).
- No no-JS fallback (unlike `/takedown`) — a two-step upload with a live progress bar has no sane plain-POST equivalent; the client script requires JS.
- **Link mode**: one POST to `/api/submit-video` (`mode: "url"`), validated (parseable `http`/`https` URL), inserted into D1 `SUBMISSIONS.video_submissions` as `submission_type='url'`.
- **Upload mode**: two steps. `POST /api/submit-video` (`mode: "upload"`) validates `mimeType`/`fileSize` (250MB per-file cap, 5GB/24h rolling cap across all uploads, MIME allowlist mp4/mov/webm/mkv/3gp) and inserts a pending row, returning its `id`. The client then does `PUT /api/upload/:id` with the raw file body via `XMLHttpRequest` (tracking `xhr.upload.progress` for the visible bar); the Worker streams it into R2 bucket `UPLOADS` at key `pending/${id}-${uuid}.${ext}` and updates the D1 row (`r2_key`, `file_size_bytes`, `mime_type`). The endpoint is single-use per id (`r2_key IS NULL` guard prevents replay/overwrite).
- Spam/abuse defenses match `/api/takedown`'s shape plus upload-specific ones: honeypot, same-origin check, a global per-minute rate cap, a stricter per-minute cap for uploads, the daily byte cap above, `content-length` enforced and cross-checked against actual bytes received, MIME allowlist checked at both the metadata step and the actual PUT.
- Nothing in `video_submissions` is ever rendered on the public site — it's a private inbox, triaged with `scripts/admin-requests.mjs` (see `content-pipeline.md`). Approving a link-mode submission there appends the URL to the master collection CSV so it flows into the next `collect-batch.mjs` run.

## 9. Corrections & takedowns

- **`/takedown`** (`src/pages/takedown.astro`) — a real `<form method="post" action="/api/takedown">` that works with JavaScript disabled; an inline script progressively enhances it to a `fetch` submission. Fields: `kind` (takedown/correction/context/other), optional `entry` reference, required `message` (10–4000 chars), optional `contact`, plus the same honeypot pattern as the submit-video form.
- **`src/worker.ts`** validates the same-origin `Origin` header (not a real security boundary, but stops trivial cross-site posting), rejects honeypot-filled submissions with a fake success (so bots don't learn to adapt), enforces field-length caps, and enforces a global flood cap (20/minute, counted across all submitters — not per-IP, since no IP is ever stored) before inserting into D1. For no-JS submissions it renders a small self-contained confirmation page inlined in the Worker (it has no access to the Astro build's hashed CSS).
- **D1 database `blackdays-takedowns`** (binding `TAKEDOWNS`), schema in `migrations/0001_takedown_requests.sql` — table `takedown_requests`: `kind`, `entry_ref`, `contact`, `message`, `created_at`, `ip_country`, `user_agent`, `status` (defaults `'new'`). Stores the request's country, never its IP address. Nothing in this table is ever rendered on the public site.
- Triage: `node scripts/admin-requests.mjs list --type takedown` (or the raw `wrangler d1 execute` shown in `CLAUDE.md`).
- Spam defense is honeypot + length caps + the global rate cap above; Turnstile is the intended next step and is not yet implemented.

## 10. Design language

True-black, Instagram-evoking palette. Concrete tokens (`src/styles/global.css`, `@theme` block, source of truth):

| Token | Value | Use |
|---|---|---|
| `--color-bg` | `#000000` | page background — pure black |
| `--color-surface` | `#121212` | elevated surface (cards, chips, sheets) |
| `--color-border` | `#262626` | hairline border/separator |
| `--color-letterbox` | `#000000` | identical to page bg — video sits in one continuous black field |
| `--color-text` | `#ffffff` | primary text (21.00:1 vs `#000`) |
| `--color-muted` | `#a8a8a8` | secondary text (8.83:1, AA) |
| `--color-tertiary` | `#737373` | decorative/disabled only — not for text a user must read (4.43:1, under AA) |
| `--color-accent` | `#ffffff` | active nav, primary buttons |
| `--color-link` | `#3b82c4` | reserved, genuinely-interactive affordances only (5.16:1 vs `#000`) |

System font stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`). Tight, app-like type scale applied to the app-shell chrome. No decorative animation beyond opacity/transform ≤200ms, wrapped in `prefers-reduced-motion: no-preference`; no autoplay audio; no clickbait patterns. Native-app details: `overscroll-behavior-y: contain`, `100svh`/`100dvh` instead of `100vh`, safe-area insets in the bottom nav, a web app manifest (`background_color`/`theme_color` `#000000`). Lighthouse targets: 100 across the board; LCP < 2s (a poster image, not video, is the LCP element on `/`).

## 11. Accessibility

Keyboard-navigable feed and controls, alt text on all thumbnails, captions surfaced when available, visible focus states, `prefers-reduced-motion` respected (no autoplay when set), color contrast AA+ (see token table above).

## 12. Credibility & safety surface

- Attribution (platform, uploader, original URL) is always visible — never stripped; the feed's primary CTA links straight to it (§7).
- Sample entries, when present, carry a prominent "SAMPLE — placeholder entry" banner and `"sample": true`. None are live right now (§4), but the code path still works if one is reintroduced.
- `/about` links to `/takedown/` for corrections and takedown requests (§9), and the home page hosts a public submit-video form (§8) — no personal contact address is published anywhere on the site or committed to the repo.
- Descriptions state what is visible, not conclusions.
- Nothing on the site claims verification status is distinguished for the reader — `/about` says plainly that nothing has been independently verified (§5, `verification-policy.md`).

## 13. File tree (current)

```
blackdays/
  docs/
  migrations/
    0001_takedown_requests.sql          D1 schema for TAKEDOWNS
    video-submissions/
      0001_video_submissions.sql        D1 schema for SUBMISSIONS
  public/
    favicon.svg
  src/
    config.ts                SITE_NAME, SITE_URL, MEDIA_BASE
    worker.ts                 Cloudflare Worker: /api/takedown, /api/submit-video, /api/upload/:id
    data/videos.json
    data/timeline.json
    lib/schema.ts             types + loadVideos()/loadTimeline(); imported by pages at build time
    layouts/Base.astro        html shell, meta defaults, header/nav/footer
    components/
      VideoCard.astro
      TimelineEvent.astro
      VerificationBadge.astro   on disk, unimported — see §5
    pages/
      index.astro              landing + submit-video form
      feed.astro
      timeline.astro
      about.astro
      takedown.astro
      404.astro
      video/[id].astro
    scripts/feed.ts            IntersectionObserver + scrubber + caption-expand + reshuffle (client)
  scripts/
    collect.mjs                see content-pipeline.md
    collect-batch.mjs
    generate-samples.mjs
    enrich.mjs
    admin-requests.mjs
  archive-originals/           raw downloads, git-ignored
  wrangler.jsonc                main (src/worker.ts), assets, d1_databases (TAKEDOWNS, SUBMISSIONS),
                                r2_buckets (UPLOADS), env.staging mirror
  astro.config.mjs
  package.json
```

## 14. Testing gotchas

Three traps that have each cost a previous session real debugging time:

- **Never open `dist/` over `file://`.** Astro emits absolute `/_astro/*.css` paths; under `file://` those resolve to filesystem root, so the stylesheet 404s silently and every computed style is wrong. Serve `dist/` over HTTP (`npx serve dist`, `astro preview`) instead.
- **Never verify the feed with the Chrome extension.** Its automation tab runs with `visibility: hidden`, which suppresses `IntersectionObserver` callbacks and blocks autoplay outright — the feed will look completely non-functional even though it works for a real user. Use headless chromium (Playwright/Puppeteer) instead.
- **Never test video seeking (the progress-bar scrubber) behind `python3 -m http.server`.** It doesn't implement HTTP Range requests, so `video.currentTime` silently refuses to move no matter what the scrubber does. Use a Range-capable server (`astro preview`, `npx serve`, or `wrangler dev`).

## 15. Explicit non-goals

User accounts, comments, likes, realtime updates, a general backend API. The Worker exists, but only for the three narrow endpoints in §8/§9 — the site is otherwise fully static.
