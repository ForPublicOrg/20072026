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

**Supersedes the "feed-as-landing" decision below (same day, 2026-07-21):** landing a visitor straight into the scrolling feed was reconsidered — the owner's framing was that the point of the archive is to let people *relive the day so it isn't forgotten*, which a silent autoplaying feed with no framing doesn't achieve on first contact. `/` is now a minimal landing page (banner, one-line context, a "Relive the day" CTA) and the feed itself moved to `/feed`, unchanged in behaviour.

**Rebuilt again the same day, this time as an Apple-product-page style scroll storyline:** the "minimal landing page" above still opened with the header/wordmark, a capped-height banner, and a paragraph stacked immediately below the fold. The owner asked for something closer to how a product page reveals itself: the entire first viewport is the poster (`100svh`, no visible "Black Days" title or app header on this route — the poster already carries the date/title text), and everything else — the factual context, the archive counts, the verification note, the closing CTA — reveals progressively as the page scrolls, one idea per section, staged fade/translate-in via `IntersectionObserver` (`src/scripts/landing.ts`). The old duplicated paragraph (the previous version stated "what happened" essentially twice, once above the CTA and once below it) is gone — each fact now appears exactly once. The bottom tab bar still floats over the hero on every breakpoint (`Base.astro`'s `overlayNav` prop forces it fixed even on desktop, where it's normally an in-flow static bar) so it never eats into the poster's `100svh`; the header is omitted on this route only (`hideHeader` prop) but a visually-hidden `<h1>` keeps the page a real heading for SEO/screen readers, and every other route is unaffected.

| Route | Content |
|---|---|
| `/` | **Landing page.** Full-viewport (`100svh`) poster hero with a "Relive the day" CTA and quiet scroll cue overlaid on it (both within the first viewport, verified numerically — see verification log), art-directed per breakpoint (wide crop on desktop, portrait crop on mobile — see below), followed by a scroll-revealed storyline: one factual paragraph on 20 July 2026, one paragraph on what the archive is plus build-time-computed counts, one line on verification linking to `/about/`, and a closing "Relive the day" CTA with quiet links to `/timeline/` and `/about/`. No visible site title on this route. |
| ~~`/` — feed-as-landing~~ | **Superseded.** Decision recorded 2026-07-21, implemented alongside the feed-card rebuild: the full-viewport reels-style feed *was* the home page, no hero to scroll past. Reversed the same day (see above) once the owner decided a visitor needs context before the feed, not instead of it. |
| ~~`/` — banner + stacked paragraphs~~ | **Superseded.** The immediately-preceding landing design (header visible, capped-height banner, paragraph directly below the fold). Reversed the same day in favour of the full-viewport poster + scroll storyline above. |
| `/feed` | The full-viewport, reels-style, scroll-snap video feed (formerly at `/`). See §8. |
| `/video/[id]` | Video player, full metadata, verification badge, original-source link, uploader, archive date, related videos (shared tags/date), unique OG meta |
| `/timeline` | Chronological event list; each event links to its related media |
| `/about` | Mission, methodology, verification policy summary, contact/takedown note |
| `404` | Real 404 (no SPA fallback) |

The landing page's poster is an **AI-generated illustration, not documentary footage**, and is labelled as such directly on the hero, on the scrim over the poster itself, legibly (13px, full `--color-text` white with a text-shadow for contrast against arbitrary artwork pixels — not the tertiary/decorative grey token, and never scrolled-past unread): "Illustration. Not documentary footage — see the archive for verified material." Same credibility line this spec draws everywhere else (§11, `verification-policy.md`): the site never lets illustrative material read as documentary material. Its `og:image` (used for WhatsApp/X/Telegram link previews) is this poster (the wide crop, as an absolute URL built from `SITE_URL`) rather than the generic `og-default.png`, since the poster is the more effective, more accurate preview for how this archive actually spreads. `/video/[id]`'s own verified absolute `og:image`/`og:type=video.other` are untouched by any of this.

Navigation is a persistent app shell, not a page-by-page header: a bottom tab bar (Home · Feed · Timeline · About) on mobile, which becomes a slim top bar on desktop so wide viewports don't look like a stretched phone. As of the true-black pass (2026-07-21), the tab bar is **icon-only** — no text captions under the icons, Instagram's own pattern — with the active tab indicated by a filled glyph vs. an outline glyph rather than a colour pill; each link carries an `aria-label` so screen-reader users lose nothing the sighted UI had. The Home tab was added when `/` stopped being the feed, so users dropped into `/feed` (or any other page) always have a one-tap way back to the landing page. Astro's `<ClientRouter />` (view transitions) morphs between routes instead of a full reload, respecting `prefers-reduced-motion`.

## 8. Feed behavior

Lives at `/feed` (moved from `/` on 2026-07-21, see §7).

- Each card ≈ full viewport: video, title, source + date, tags, verification badge, description.
- **IntersectionObserver**: when a card is ≥60% visible → muted autoplay; when it leaves → pause and reset nothing (resume position kept).
- `preload="none"`, poster = thumbnail. Video `src` is attached only for the current and next card; detached beyond that. The archive can grow to thousands of entries without the homepage degrading.
- Tap/click toggles sound. Keyboard: cards focusable, space/enter toggles play.
- Mobile-first layout; desktop centers the column (~`max-w-xl`).
- The feed is a full-bleed, fixed-height scroll container beneath the app shell (`Base.astro`'s `fullBleed` prop removes page padding and document scroll so the feed owns its own snap-scrolling), not a normal padded page.

## 9. Design language

**History (all 2026-07-21, three states in one day):**

1. **Original:** a dark, sober "digital archive" palette (`#0a0a0b` background) — the first version of the site.
2. **Light reversal:** at the owner's direction, flipped to a white, Instagram-evoking palette (`#ffffff` background), to read as a native mobile app rather than a sober archive.
3. **True-black reversal (current, supersedes #2):** the owner reviewed a real Instagram screenshot and reversed course again — Instagram's actual mobile feed is **pure black** (`#000000`), not white, and not the dark grey the original dark attempt used either. The light theme is judged to read as less premium than the reference. This is the current, approved state.

**What changed from the light theme to true black:** background flips from white (`#ffffff`) back to pure black (`#000000`) — deliberately `#000000`, not a "dark grey" like the original `#0a0a0b`/`#141416`, which read as cheap rather than premium; text flips from near-black to white (`#ffffff`); the letterbox behind portrait video is now the *same* `#000000` as the page background, so video sits in one continuous black field instead of a visible seam. The header and bottom nav, previously translucent white bars with backdrop blur, are now solid opaque black — translucency would let scrolled content show through as non-black colour, which is exactly the seam this pass exists to remove. The bottom tab bar drops its text captions entirely (icon-only, active state = filled vs. outline glyph, not a colour pill) — see §7. Verification badge colors were re-derived a third time for pure black (see table below). Blue (`#0095f6`) remains reserved for genuinely interactive affordances only.

**Why the feed card is changing shape, not just colour:** alongside this pass, the feed card is moving from a Reels-style full-bleed overlay (metadata scrimmed on top of the video) to Instagram's main-feed layout (metadata above/below the video, both sitting on plain black). An archive entry carries materially more metadata than a social post — source, uploader, archive date, verification status, description — and overlaying all of that on top of footage hurts both legibility and credibility (attribution text should not be fighting the video for contrast). This restructure is out of scope for this pass and tracked separately; expect the feed to look unfinished relative to the rest of the shell until it lands.

**What didn't change, and why this is still credible:** this is an archive of protest documentation, not a social product, and the credibility argument in §11 does not rest on the aesthetic being light, dark, or black. It rests on persistent attribution (platform, uploader, original URL — always visible, §11), the verification badge being present on every item and never defaulted upward, and the explicit SAMPLE banner on placeholder content. None of §11's rules changed across any of the three palette states. What a "serious" visual register buys you is a *prior*, not a proof — a reader still has to check the badge and the attribution either way.

Concrete tokens (see `src/styles/global.css` for the source of truth):

| Token | Value | Use |
|---|---|---|
| `--color-bg` | `#000000` | page background — pure black, not dark grey |
| `--color-surface` | `#121212` | elevated surface (cards, chips) |
| `--color-border` | `#262626` | hairline border/separator |
| `--color-letterbox` | `#000000` | identical to page bg — video sits in one continuous black field, no seam |
| `--color-text` | `#ffffff` | primary text (21.00:1 vs `#000`) |
| `--color-muted` | `#a8a8a8` | secondary text (8.83:1 vs `#000`, AA) |
| `--color-tertiary` | `#737373` | decorative/disabled only — not for text a user must read (4.43:1, under AA) |
| `--color-accent` | `#ffffff` | active nav, primary buttons |
| `--color-link` | `#0095f6` | reserved, genuinely-interactive affordances only (6.63:1 vs `#000`) |

Verification badge colors were re-derived for pure black. The earlier light-theme pass had split the badge into `light` (on-white) and `scrim` (on a dark video gradient) variants; both prop values are kept for backward compatibility with existing call sites, but both now render against the same `#000000` app surface and share one set of text/dot colors — they differ only in the chip's background treatment (`scrim` keeps a stronger opaque chip since it sits over arbitrary video pixels, not a guaranteed-black surface). See `src/components/VerificationBadge.astro`. Measured contrast ratios (WCAG relative-luminance formula), text/dot color vs. `#000000`:

| Status | Color | Contrast vs `#000000` |
|---|---|---|
| Verified | `#5fd88a` | 11.68:1 |
| Likely verified | `#5eead4` | 14.20:1 |
| Partially verified | `#fbbf24` | 12.58:1 |
| Unverified | `#e5e5e5` | 16.67:1 |
| Context unclear | `#fb923c` | 9.28:1 |

All five clear WCAG AA (4.5:1) with wide margin. They remain muted and informational, never alarmist, per `verification-policy.md`.

System font stack; tight, app-like type scale (14px body, 13px secondary, semibold (600) usernames, generous line-height) applied to the app-shell chrome (header, nav). Generous whitespace; no decorative animation beyond opacity/transform ≤200ms, all wrapped in `prefers-reduced-motion: no-preference`; no autoplay audio; no clickbait patterns. Native-app details: `overscroll-behavior-y: contain`, `100svh`/`100dvh` instead of `100vh`, safe-area insets respected in the bottom nav, a web app manifest (`background_color`/`theme_color` `#000000`) so "Add to Home Screen" behaves like an installed app. Lighthouse targets: 100 across the board; LCP < 2s (a poster image, not video, is the LCP element).

## 10. Accessibility

Keyboard navigable feed and controls, alt text on all thumbnails, captions surfaced when available, visible focus states, prefers-reduced-motion respected (no autoplay when set), color contrast AA+.

## 11. Credibility & safety surface

- Attribution (platform, uploader, original URL) is always visible — never stripped.
- Sample entries carry a prominent "SAMPLE — placeholder entry" banner and `"sample": true`.
- `/about` includes a contact address for corrections and takedown requests.
- Descriptions state what is visible, not conclusions.

## 12. Explicit non-goals

User accounts, comments, likes, visitor uploads, realtime updates, backend APIs. (Unchanged from initial doc.)
