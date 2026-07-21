# Black Days — Design Specification

**Date:** 2026-07-21
**Status:** Approved
**Domain:** blackdays.in

## 1. What this is

A static archive website that documents publicly available videos, photos, and reporting related to a specific protest event. The objectives are **preservation, discoverability, and historical documentation** — not commentary. **Update (2026-07-21, commit `b8f0fdc`):** this spec previously said the site "clearly distinguishes verified from unverified material." It does not, and the `/about` page was rewritten to say so plainly rather than imply otherwise — nothing in the archive has been independently verified. The site preserves attribution to original sources and avoids editorializing; verification status is still recorded internally (see `docs/verification-policy.md`) but is not displayed anywhere in the UI as of this date.

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

`src/data/timeline.json` — array of:

```jsonc
{
  "time": "2026-05-15",           // date-only ISO string — no clock time; see §8 rendering note
  "title": "…",
  "description": "…",
  "relatedVideoIds": [],          // must reference existing video ids; validated at build time
  "sources": [                    // optional; added 2026-07-21 (commit b8f0fdc)
    { "title": "…", "url": "https://…" }
  ]
}
```

**`sources` (optional, added 2026-07-21):** each timeline event may carry a `sources` array of `{ title, url }` citations to the reporting the entry is drawn from. Validated in `src/lib/schema.ts` (`TimelineSource`): if present, `sources` must be an array, each item needs a non-empty `title` and an absolute `http(s)` `url` — a malformed citation fails the build rather than silently vanishing from the page, since a timeline entry whose sourcing quietly disappeared is worse than one that never claimed any. Rendered by `TimelineEvent.astro` as a small linked list under the description, each opening in a new tab. See `docs/content-pipeline.md` for how the current 14 events were researched and sourced (Al Jazeera, NPR, Wikipedia).

**`videos.json` real vs. sample (updated 2026-07-21):** the eight `sample: true` placeholder entries and their media (`public/media/videos/video-001.mp4` … `video-008.mp4` and matching thumbnails) were deleted once real footage existed to replace them. Five real entries remain (`video-009` … `video-013`). The `sample` field itself is still part of the schema and still supported end-to-end (build validation, the `/video/[id]` placeholder banner, the landing page's sample count) — there just isn't any data using it right now. See `docs/content-pipeline.md`.

**`MEDIA_BASE`**: single constant in `src/config.ts`. Day 1 it is `/media/` (site assets); when R2 is live it becomes `https://media.blackdays.in/`. Data files never change.

## 6. Verification levels

Five levels, recorded on every entry, never implied beyond what is known (full criteria in `verification-policy.md`):

`verified` · `likely-verified` · `partially-verified` · `unverified` · `context-unclear`

Everything entering via the pipeline starts as `unverified`. Upgrades are manual, deliberate edits to `videos.json`.

**Display history, all 2026-07-21 (superseded twice in one day):**

1. **Originally:** the badge was always shown on `/video/[id]` and on every feed card.
2. **Feed display exception (midday):** on `/feed` cards, the badge was suppressed when the status was `unverified` — the default nearly every entry starts on, and at the time of this change 4 of 5 real entries still carried it. A label identical on almost every card conveyed no information and made the feed read as defensive rather than credible. The other four statuses still rendered on feed cards (three add credibility, `context-unclear` flags an actively disputed framing — that is information). `/video/[id]` was unaffected — it kept showing the badge unconditionally.
3. **Total removal (evening, commit `b8f0fdc`), current state:** the badge is not rendered anywhere — not the feed, not `/video/[id]`, not `/about`. `src/components/VerificationBadge.astro` still exists with its full implementation but is no longer imported by any page or component. This removed the *display* only: `verificationStatus` is still a required field, still validated in `src/lib/schema.ts`, and every entry still has exactly one status. See `docs/verification-policy.md` "Display rules" for the full account and the reasoning for keeping the data despite showing nothing.

## 7. Pages

**Supersedes the "feed-as-landing" decision below (same day, 2026-07-21):** landing a visitor straight into the scrolling feed was reconsidered — the owner's framing was that the point of the archive is to let people *relive the day so it isn't forgotten*, which a silent autoplaying feed with no framing doesn't achieve on first contact. `/` is now a minimal landing page (banner, one-line context, a "Relive the day" CTA) and the feed itself moved to `/feed`, unchanged in behaviour.

**Rebuilt again the same day, this time as an Apple-product-page style scroll storyline:** the "minimal landing page" above still opened with the header/wordmark, a capped-height banner, and a paragraph stacked immediately below the fold. The owner asked for something closer to how a product page reveals itself: the entire first viewport is the poster (`100svh`, no visible "Black Days" title or app header on this route — the poster already carries the date/title text), and everything else — the factual context, the archive counts, the verification note, the closing CTA — reveals progressively as the page scrolls, one idea per section, staged fade/translate-in via `IntersectionObserver` (`src/scripts/landing.ts`). The old duplicated paragraph (the previous version stated "what happened" essentially twice, once above the CTA and once below it) is gone — each fact now appears exactly once. The bottom tab bar still floats over the hero on every breakpoint (`Base.astro`'s `overlayNav` prop forces it fixed even on desktop, where it's normally an in-flow static bar) so it never eats into the poster's `100svh`; the header is omitted on this route only (`hideHeader` prop) but a visually-hidden `<h1>` keeps the page a real heading for SEO/screen readers, and every other route is unaffected.

| Route | Content |
|---|---|
| `/` | **Landing page.** Full-viewport (`100svh`) poster hero with a "Relive the day" CTA and quiet scroll cue overlaid on it (both within the first viewport, verified numerically — see verification log), art-directed per breakpoint (wide crop on desktop, portrait crop on mobile — see below), followed by a scroll-revealed storyline: one factual paragraph on 20 July 2026, one paragraph on what the archive is plus build-time-computed counts, one line on verification linking to `/about/`, and a closing "Relive the day" CTA with quiet links to `/timeline/` and `/about/`. No visible site title on this route. |
| ~~`/` — feed-as-landing~~ | **Superseded.** Decision recorded 2026-07-21, implemented alongside the feed-card rebuild: the full-viewport reels-style feed *was* the home page, no hero to scroll past. Reversed the same day (see above) once the owner decided a visitor needs context before the feed, not instead of it. |
| ~~`/` — banner + stacked paragraphs~~ | **Superseded.** The immediately-preceding landing design (header visible, capped-height banner, paragraph directly below the fold). Reversed the same day in favour of the full-viewport poster + scroll storyline above. |
| `/feed` | The full-viewport, reels-style, scroll-snap video feed (formerly at `/`). See §8. |
| `/video/[id]` | Video player, full metadata, original-source link, uploader, archive date, related videos (shared tags/date), unique OG meta. **No verification badge as of 2026-07-21** — see §6. Still shows the "Sample — placeholder entry" banner when `video.sample` is true, though no current entry sets it. |
| `/timeline` | Chronological event list; each event links to its related media and, when present, to the `sources` it cites (added 2026-07-21 — see §5). |
| `/about` | Mission, where the material comes from, an explicit statement that nothing has been independently verified, a link to `/timeline/`, and a "Make a request" link to `/takedown/` for corrections and takedowns. **Rewritten 2026-07-21 (commit `b8f0fdc`)** — see §11 and `docs/verification-policy.md`; the previous version summarized all five verification statuses and gave a `mailto:` contact address, both now removed. |
| `/takedown` | **Added 2026-07-21.** Corrections/takedown form; posts to `/api/takedown` (`src/worker.ts`), stores rows in D1. Works with JavaScript disabled. See §12. |
| `404` | Real 404 (no SPA fallback) |

The landing page's poster is an **AI-generated illustration, not documentary footage**, and is labelled as such directly on the hero, on the scrim over the poster itself, legibly (13px, full `--color-text` white with a text-shadow for contrast against arbitrary artwork pixels — not the tertiary/decorative grey token, and never scrolled-past unread): "Illustration. Not documentary footage — see the archive for verified material." Same credibility line this spec draws everywhere else (§11, `verification-policy.md`): the site never lets illustrative material read as documentary material. Its `og:image` (used for WhatsApp/X/Telegram link previews) is this poster (the wide crop, as an absolute URL built from `SITE_URL`) rather than the generic `og-default.png`, since the poster is the more effective, more accurate preview for how this archive actually spreads. `/video/[id]`'s own verified absolute `og:image`/`og:type=video.other` are untouched by any of this.

Navigation is a persistent app shell, not a page-by-page header: a bottom tab bar (Home · Feed · Timeline · About) on mobile, which becomes a slim top bar on desktop so wide viewports don't look like a stretched phone. As of the true-black pass (2026-07-21), the tab bar is **icon-only** — no text captions under the icons, Instagram's own pattern — with the active tab indicated by a filled glyph vs. an outline glyph rather than a colour pill; each link carries an `aria-label` so screen-reader users lose nothing the sighted UI had. The Home tab was added when `/` stopped being the feed, so users dropped into `/feed` (or any other page) always have a one-tap way back to the landing page. Astro's `<ClientRouter />` (view transitions) morphs between routes instead of a full reload, respecting `prefers-reduced-motion`.

## 8. Feed behavior

Lives at `/feed` (moved from `/` on 2026-07-21, see §7).

- Each card is an Instagram-main-feed-style post, not a Reels overlay: a post header (avatar monogram, uploader handle, location), the video as its own letterboxed block, a meta row, then a caption block — all on plain black, never metadata burned over the footage (see §9, "Why the feed card is changing shape").
- **Card rebuilt 2026-07-21 (commit `b8f0fdc`)**, alongside the verification-badge removal:
  - The former "Details →" link to `/video/[id]` is gone. The meta row's CTA is now the platform name itself — "View on {platform} ↗" — linking straight to `video.source.url` (`target="_blank" rel="noopener noreferrer"`), so credibility routes to the person who filmed it rather than to this site's own page.
  - The "more" control is a `<button>`, not a link: it expands the caption in place (toggling a `.is-expanded` class, capped to ~30% of the card's own height with internal scroll) instead of navigating away. It only becomes visible once script measures that the 2-line clamp is actually clipping the caption.
  - The progress bar is a real scrubber, not a passive meter: `role="slider"` with the `aria-value*` triad, click-to-seek, pointer-drag-to-scrub, and arrow-key nudging (`ArrowLeft`/`ArrowRight`/`ArrowUp`/`ArrowDown` ±5s, `Home`/`End`). The visible bar stays a thin 3px (Instagram-style); the hit area is padded to 20px tall since a 3px target isn't reliably tappable. All of this lives in `src/scripts/feed.ts` (`setupProgressBar`, `setupMoreButton`) and `src/components/VideoCard.astro`.
  - No verification badge on the card — see §6.
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

**What changed from the light theme to true black:** background flips from white (`#ffffff`) back to pure black (`#000000`) — deliberately `#000000`, not a "dark grey" like the original `#0a0a0b`/`#141416`, which read as cheap rather than premium; text flips from near-black to white (`#ffffff`); the letterbox behind portrait video is now the *same* `#000000` as the page background, so video sits in one continuous black field instead of a visible seam. The header and bottom nav, previously translucent white bars with backdrop blur, are now solid opaque black — translucency would let scrolled content show through as non-black colour, which is exactly the seam this pass exists to remove. The bottom tab bar drops its text captions entirely (icon-only, active state = filled vs. outline glyph, not a colour pill) — see §7. Verification badge colors were re-derived a third time for pure black (see table below, kept for historical record even though nothing renders it as of 2026-07-21 evening — see §6). Blue (`#0095f6`) remains reserved for genuinely interactive affordances only.

**Why the feed card is changing shape, not just colour:** alongside this pass, the feed card is moving from a Reels-style full-bleed overlay (metadata scrimmed on top of the video) to Instagram's main-feed layout (metadata above/below the video, both sitting on plain black). An archive entry carries materially more metadata than a social post — source, uploader, archive date, description — and overlaying all of that on top of footage hurts both legibility and credibility (attribution text should not be fighting the video for contrast). This restructure landed the same day, later, in commit `b8f0fdc` (see §7/§8): the card is now the Instagram-main-feed shape described there, with the "Details →" link replaced by a source link, the "more" control expanding in place, a real scrubber, and no verification badge.

**What didn't change, and why this is still credible:** this is an archive of protest documentation, not a social product, and the credibility argument in §11 does not rest on the aesthetic being light, dark, or black, or on whether a verification badge is currently rendered. It rests on persistent attribution (platform, uploader, original URL — always visible, §11) and, since 2026-07-21 evening, on routing the feed's primary CTA to the original public post rather than this site's own page. The verification badge's removal from the UI (§6) is a real change to this argument's shape — a reader visiting the feed or a video page no longer sees a per-item status at all, only the underlying data (still recorded, not displayed) and the about page's blanket statement that nothing here is independently verified. What a "serious" visual register buys you is a *prior*, not a proof — a reader still has to check the attribution and, now, follow the source link themselves.

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

**Historical record — nothing in this table currently renders (badge display removed 2026-07-21 evening, commit `b8f0fdc`; see §6 for the full sequence).** Kept here because `src/components/VerificationBadge.astro` still exists on disk, unimported, with these exact values, and whoever reinstates badge display later shouldn't have to re-derive them. Verification badge colors were re-derived for pure black as part of the true-black pass, before removal. The earlier light-theme pass had split the badge into `light` (on-white) and `scrim` (on a dark video gradient) variants; both prop values were kept for backward compatibility with existing call sites, but both rendered against the same `#000000` app surface and shared one set of text/dot colors — they differed only in the chip's background treatment (`scrim` kept a stronger opaque chip since it sat over arbitrary video pixels, not a guaranteed-black surface). Measured contrast ratios (WCAG relative-luminance formula), text/dot color vs. `#000000`:

| Status | Color | Contrast vs `#000000` |
|---|---|---|
| Verified | `#5fd88a` | 11.68:1 |
| Likely verified | `#5eead4` | 14.20:1 |
| Partially verified | `#fbbf24` | 12.58:1 |
| Unverified | `#e5e5e5` | 16.67:1 |
| Context unclear | `#fb923c` | 9.28:1 |

All five cleared WCAG AA (4.5:1) with wide margin, and remained muted and informational, never alarmist, per `verification-policy.md` — that policy's substance is unchanged even though these colors have nothing left to color.

System font stack; tight, app-like type scale (14px body, 13px secondary, semibold (600) usernames, generous line-height) applied to the app-shell chrome (header, nav). Generous whitespace; no decorative animation beyond opacity/transform ≤200ms, all wrapped in `prefers-reduced-motion: no-preference`; no autoplay audio; no clickbait patterns. Native-app details: `overscroll-behavior-y: contain`, `100svh`/`100dvh` instead of `100vh`, safe-area insets respected in the bottom nav, a web app manifest (`background_color`/`theme_color` `#000000`) so "Add to Home Screen" behaves like an installed app. Lighthouse targets: 100 across the board; LCP < 2s (a poster image, not video, is the LCP element).

## 10. Accessibility

Keyboard navigable feed and controls, alt text on all thumbnails, captions surfaced when available, visible focus states, prefers-reduced-motion respected (no autoplay when set), color contrast AA+.

## 11. Credibility & safety surface

- Attribution (platform, uploader, original URL) is always visible — never stripped. As of 2026-07-21, the feed's primary link *is* this attribution: the platform name links out to `video.source.url` (§8).
- Sample entries, when present, carry a prominent "SAMPLE — placeholder entry" banner and `"sample": true`. As of 2026-07-21 there are none in the live data (the eight original placeholders were deleted, §5) but the banner code path (`/video/[id]`) and the landing page's sample count still work if one is reintroduced.
- `/about` links to `/takedown/` for corrections and takedown requests (§12) — **changed 2026-07-21**, previously a `mailto:` contact address.
- Descriptions state what is visible, not conclusions.
- Nothing on the site claims verified/unverified status is distinguished for the reader — **changed 2026-07-21**: the `/about` page previously said the site "clearly distinguishes verified from unverified material"; it now says plainly that nothing has been independently verified (§1, §6, `docs/verification-policy.md`).

## 12. Corrections & takedowns

**Added 2026-07-21 (commit `b8f0fdc`).** The maintainer's personal email address is no longer published anywhere on the site or committed to the repository (`CONTACT_EMAIL` was removed from `src/config.ts`). In its place:

- **`/takedown`** (`src/pages/takedown.astro`) — a real `<form method="post" action="/api/takedown">` that works with JavaScript disabled. An inline script progressively enhances it to a `fetch` submission so a JS-enabled visitor keeps their place instead of navigating to a confirmation page. Fields: `kind` (takedown / correction / context / other), optional `entry` reference, required `message` (10–4000 chars), optional `contact`, plus a hidden honeypot field (`website`) invisible to people via off-screen CSS positioning (not `display: none`, since some bots skip fields hidden that way).
- **`src/worker.ts`** — the Cloudflare Worker that `/api/takedown` posts to. It is the *only* reason the site now has a Worker at all: `wrangler.jsonc` gained `main: "./src/worker.ts"` alongside the existing `assets` block. Because `assets` is configured alongside `main`, Cloudflare serves matching static files **without invoking the Worker** — the site is still fundamentally a static build; the Worker only runs for `/api/*`. It validates the same-origin `Origin` header (not a real security boundary, but stops trivial cross-site posting), rejects honeypot-filled submissions with a fake success (so bots don't learn to adapt), enforces field-length caps (`MAX_MESSAGE = 4000`, `MAX_SHORT_FIELD = 300`), and enforces a global flood cap (`MAX_PER_MINUTE = 20`, counted across all submitters — not per-IP, since no IP is stored) before inserting into D1. For no-JS submissions it renders a small self-contained confirmation page (`CONFIRMATION_HTML`, inlined in the Worker since it has no access to the Astro build's hashed CSS).
- **D1 database `blackdays-takedowns`** (binding `TAKEDOWNS`), schema in `migrations/0001_takedown_requests.sql`. Table `takedown_requests`: `kind`, `entry_ref`, `contact`, `message`, `created_at`, `ip_country`, `user_agent`, `status` (defaults `'new'`). **Deliberately stores the request's country, never its IP address** — enough to triage a flood, not enough to identify someone reporting a problem with an archive like this one. Nothing in this table is ever rendered back onto the public site; it is a private inbox.
- **Spam defence, current state:** honeypot field + per-field length caps + the global per-minute cap above. **Turnstile is the intended next step and is not yet implemented.**
- **Reading submissions** (maintainer only, requires `wrangler` auth):
  ```sh
  npx wrangler d1 execute blackdays-takedowns --remote --command "SELECT * FROM takedown_requests ORDER BY created_at DESC"
  ```
- The `/about` page's "Corrections & takedowns" section and the site footer both link to `/takedown/` (previously a `mailto:` link built from `CONTACT_EMAIL`, both removed from `src/layouts/Base.astro` and `src/pages/about.astro`).

## 13. Explicit non-goals

User accounts, comments, likes, visitor uploads, realtime updates, backend APIs. (Unchanged from initial doc — note that a Worker now exists per §12, but it is a narrow-purpose form endpoint, not a general backend API; the site is still fully static otherwise.)
