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
| `/` | **Feed-as-landing** (decision recorded 2026-07-21, implemented alongside the feed-card rebuild): the full-viewport reels-style feed *is* the home page, not a hero section the visitor must scroll past. The feed is the app; the mission statement moves to `/about` so it doesn't block the first card. |
| `/video/[id]` | Video player, full metadata, verification badge, original-source link, uploader, archive date, related videos (shared tags/date), unique OG meta |
| `/timeline` | Chronological event list; each event links to its related media |
| `/about` | Mission, methodology, verification policy summary, contact/takedown note |
| `404` | Real 404 (no SPA fallback) |

Navigation is a persistent app shell, not a page-by-page header: a bottom tab bar (Feed · Timeline · About) on mobile, which becomes a slim top bar on desktop so wide viewports don't look like a stretched phone. Astro's `<ClientRouter />` (view transitions) morphs between the three routes instead of a full white-flash reload, respecting `prefers-reduced-motion`.

## 8. Feed behavior

- Each card ≈ full viewport: video, title, source + date, tags, verification badge, description.
- **IntersectionObserver**: when a card is ≥60% visible → muted autoplay; when it leaves → pause and reset nothing (resume position kept).
- `preload="none"`, poster = thumbnail. Video `src` is attached only for the current and next card; detached beyond that. The archive can grow to thousands of entries without the homepage degrading.
- Tap/click toggles sound. Keyboard: cards focusable, space/enter toggles play.
- Mobile-first layout; desktop centers the column (~`max-w-xl`).
- The feed is a full-bleed, fixed-height scroll container beneath the app shell (`Base.astro`'s `fullBleed` prop removes page padding and document scroll so the feed owns its own snap-scrolling), not a normal padded page.

## 9. Design language

**Superseded 2026-07-21, at the site owner's explicit direction.** The dark, sober, "digital archive" palette below was the original approach and shipped in the first version of the site. The owner then asked for the opposite: the site should feel like a **native mobile app**, specifically evoking Instagram — sophisticated, minimal, and **light** (white). This is a full reversal of the palette, not a tweak, and it is intentional.

**What changed:** background flips from near-black (`#0a0a0b`) to white (`#ffffff`); text flips from off-white to near-black (`#262626`); the amber accent (`#c9a227`) is replaced by a restrained near-black accent, with a blue (`#0095f6`) reserved only for genuinely interactive affordances if one is ever needed. Verification badge colors were re-derived from scratch for the light background — the original set was tuned for a dark surface and fails WCAG AA on white. Navigation moves from a simple header link row to a persistent bottom tab bar (mobile) / slim top bar (desktop) — see §7. View transitions were added so route changes feel like an app, not a document reload.

**What didn't change, and why this is still credible:** this is an archive of protest documentation, not a social product, and the credibility argument in §11 does not rest on the aesthetic being sober or dark. It rests on persistent attribution (platform, uploader, original URL — always visible, §11), the verification badge being present on every item and never defaulted upward, and the explicit SAMPLE banner on placeholder content. A light, native-app-feeling shell does not weaken any of that; none of §11's rules changed. What a "serious" visual register buys you is a *prior*, not a proof — a reader still has to check the badge and the attribution either way. The bet here is that a familiar, low-friction, native-feeling surface gets more people to actually scroll the archive and read those attributions, which is the point of an archive that wants to be seen.

Concrete tokens (see `src/styles/global.css` for the source of truth):

| Token | Value | Use |
|---|---|---|
| `--color-bg` | `#ffffff` | page background |
| `--color-surface` | `#fafafa` | elevated surface (cards, chips) |
| `--color-border` | `#dbdbdb` | hairline border |
| `--color-letterbox` | `#000000` | always black behind portrait video, even in light mode — portrait video on white looks broken, and Instagram itself letterboxes on black in light mode |
| `--color-text` | `#262626` | primary text (15.1:1 vs white) |
| `--color-muted` | `#737373` | secondary text (4.74:1 vs white, AA) |
| `--color-tertiary` | `#c7c7c7` | decorative/disabled only — not for text a user must read (1.7:1) |
| `--color-accent` | `#262626` | active nav, primary buttons, links |
| `--color-link` | `#0095f6` | reserved, genuinely-interactive affordances only |

Verification badge colors were re-derived in two variants — `light` (on-white, detail/timeline pages) and `scrim` (over a dark gradient on video, feed cards) — because the same color that reads fine on a dark scrim can fail contrast on white. See `src/components/VerificationBadge.astro`. Measured contrast ratios (WCAG relative-luminance formula):

| Status | on-white text vs `#ffffff` | on-scrim text vs `#000000` |
|---|---|---|
| Verified | `#146c2e` — 6.53:1 | `#5fd88a` — 11.68:1 |
| Likely verified | `#0d6b6b` — 6.30:1 | `#5eead4` — 14.20:1 |
| Partially verified | `#7a5900` — 6.45:1 | `#fbbf24` — 12.58:1 |
| Unverified | `#595959` — 7.00:1 | `#e5e5e5` — 16.67:1 |
| Context unclear | `#9a4200` — 6.66:1 | `#fb923c` — 9.28:1 |

All five clear WCAG AA (4.5:1) with margin, on both surfaces the badge actually appears on. They remain muted and informational, never alarmist, per `verification-policy.md`.

System font stack; tight, app-like type scale (14px body, 13px secondary, generous line-height) applied to the app-shell chrome (header, nav). Generous whitespace; no decorative animation beyond opacity/transform ≤200ms, all wrapped in `prefers-reduced-motion: no-preference`; no autoplay audio; no clickbait patterns. Native-app details: `overscroll-behavior-y: contain`, `100svh`/`100dvh` instead of `100vh`, safe-area insets respected in the bottom nav, a web app manifest so "Add to Home Screen" behaves like an installed app. Lighthouse targets: 100 across the board; LCP < 2s (a poster image, not video, is the LCP element).

## 10. Accessibility

Keyboard navigable feed and controls, alt text on all thumbnails, captions surfaced when available, visible focus states, prefers-reduced-motion respected (no autoplay when set), color contrast AA+.

## 11. Credibility & safety surface

- Attribution (platform, uploader, original URL) is always visible — never stripped.
- Sample entries carry a prominent "SAMPLE — placeholder entry" banner and `"sample": true`.
- `/about` includes a contact address for corrections and takedown requests.
- Descriptions state what is visible, not conclusions.

## 12. Explicit non-goals

User accounts, comments, likes, visitor uploads, realtime updates, backend APIs. (Unchanged from initial doc.)
