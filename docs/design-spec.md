# Black Days — Design Specification

**Date:** 2026-07-21
**Status:** Approved
**Domain:** blackdays.in

## 1. What this is

A static archive website that documents publicly available videos, photos, and reporting related to a specific protest event. The objectives are **preservation, discoverability, and historical documentation** — not commentary. The site clearly distinguishes verified from unverified material, preserves attribution to original sources, and avoids editorializing.

This spec refines `initial-doc.md` with the concrete decisions made on 2026-07-21.

## 2. Confirmed decisions

| Decision | Choice | Why |
|---|---|---|
| Hosting | Cloudflare **Workers static assets** | Pages is in maintenance mode; Workers is Cloudflare's current direction, same free CDN, one-command deploy |
| Domain | **blackdays.in** (registered at Namecheap) | Move DNS to a free Cloudflare zone; attach custom domain to the Worker. Site is live on `*.workers.dev` immediately |
| Launch content | **Sample data** + working pipeline | No real content collected yet; sample entries are unmistakably labeled so credibility is never compromised |
| Day-1 scope | Hero + feed, `/video/:id` pages, timeline | Individual pages with OG tags are what make shared links render rich previews — essential for spread |
| Media storage | Site assets (day 1) → **R2** (`media.blackdays.in`) | Zero egress fees; a single `MEDIA_BASE` config switches without data rewrites |

## 3. Architecture

```
Collection scripts (yt-dlp + ffmpeg, local)
        │
        ▼
src/data/videos.json ── validated at build time (TS schema)
src/data/timeline.json
        │
        ▼
Astro static build (all pages pre-rendered)
        │
        ▼
Cloudflare Worker (static assets)  +  R2 (real media, later)
```

- **Fully static output.** No server, no database, no API, no auth.
- **Build-time page generation.** Every video gets a pre-rendered `/video/:id` page with unique `<title>`, description, and OG/Twitter meta pointing at its thumbnail. This is deliberate: WhatsApp/X/Telegram link previews only work with server-rendered meta, and static generation is the zero-cost way to get it.
- **Build-time validation.** A malformed `videos.json` entry fails the build, never the live site.
- **Minimal JavaScript.** One small vanilla-TS script for feed autoplay behavior. No framework runtime shipped to the client.

## 4. Technology

- **Astro** (static output) + **TypeScript** (strict) + **Tailwind CSS**
- **Cloudflare Workers** static assets, deployed with `wrangler deploy`
- **Cloudflare R2** for media once real content lands
- Collection tooling: **yt-dlp**, **ffmpeg/ffprobe** (local, not part of the deploy)

## 5. Data model

`src/data/videos.json` — array of:

```jsonc
{
  "id": "video-001",              // stable slug, never reused
  "title": "…",
  "description": "…",             // factual, no editorializing
  "date": "2026-07-20",           // date of the event depicted (ISO)
  "location": "…",
  "tags": ["…"],
  "verificationStatus": "unverified", // see verification-policy.md
  "sample": true,                  // present + true ONLY for placeholder entries
  "source": {
    "platform": "YouTube",
    "url": "…",                   // original public URL — always preserved
    "uploader": "…",
    "publishedAt": "…"
  },
  "media": {
    "video": "videos/video-001.mp4",      // path relative to MEDIA_BASE
    "thumbnail": "thumbnails/video-001.jpg",
    "duration": 42,                // seconds, from ffprobe
    "width": 720,
    "height": 1280
  },
  "archivedAt": "2026-07-21"
}
```

`src/data/timeline.json` — array of `{ time, title, description, relatedVideoIds[] }`.

**`MEDIA_BASE`**: single constant in `src/config.ts`. Day 1 it is `/media/` (site assets); when R2 is live it becomes `https://media.blackdays.in/`. Data files never change.

## 6. Verification levels

Five levels, always displayed, never implied beyond what is known (full criteria in `verification-policy.md`):

`verified` · `likely-verified` · `partially-verified` · `unverified` · `context-unclear`

Everything entering via the pipeline starts as `unverified`. Upgrades are manual, deliberate edits to `videos.json`.

## 7. Pages

| Route | Content |
|---|---|
| `/` | Hero (title, one-paragraph intro, timeline link, scroll cue) + full-viewport reels-style feed |
| `/video/[id]` | Video player, full metadata, verification badge, original-source link, uploader, archive date, related videos (shared tags/date), unique OG meta |
| `/timeline` | Chronological event list; each event links to its related media |
| `/about` | Mission, methodology, verification policy summary, contact/takedown note |
| `404` | Real 404 (no SPA fallback) |

## 8. Feed behavior

- Each card ≈ full viewport: video, title, source + date, tags, verification badge, description.
- **IntersectionObserver**: when a card is ≥60% visible → muted autoplay; when it leaves → pause and reset nothing (resume position kept).
- `preload="none"`, poster = thumbnail. Video `src` is attached only for the current and next card; detached beyond that. The archive can grow to thousands of entries without the homepage degrading.
- Tap/click toggles sound. Keyboard: cards focusable, space/enter toggles play.
- Mobile-first layout; desktop centers the column (~`max-w-xl`).

## 9. Design language

A modern digital archive, not a social platform. Dark, sober, high-contrast palette; system font stack; generous whitespace; no decorative animation, no autoplay audio, no clickbait patterns. Verification badge colors are muted, not alarmist. Lighthouse targets: 100 across the board; LCP < 2s (hero poster image, not video, is the LCP element).

## 10. Accessibility

Keyboard navigable feed and controls, alt text on all thumbnails, captions surfaced when available, visible focus states, prefers-reduced-motion respected (no autoplay when set), color contrast AA+.

## 11. Credibility & safety surface

- Attribution (platform, uploader, original URL) is always visible — never stripped.
- Sample entries carry a prominent "SAMPLE — placeholder entry" banner and `"sample": true`.
- `/about` includes a contact address for corrections and takedown requests.
- Descriptions state what is visible, not conclusions.

## 12. Explicit non-goals

User accounts, comments, likes, visitor uploads, realtime updates, backend APIs. (Unchanged from initial doc.)
