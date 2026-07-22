# Black Days — Implementation Guide

Step-by-step build instructions for launch day. Written so any engineer (or model) can execute without re-deriving decisions. Read `design-spec.md` first; this doc is the "how".

## 0. Target file tree

```
blackdays/
  docs/                      (already written)
  migrations/
    0001_takedown_requests.sql   D1 schema for corrections/takedown requests (added 2026-07-21)
  public/
    media/videos/            real clips (git-ignored ok if regenerable)
    media/thumbnails/
    favicon.svg
  src/
    config.ts                MEDIA_BASE, SITE_URL, SITE_NAME (no contact email — see §2)
    worker.ts                Cloudflare Worker entry point; POSTs to /api/takedown only (added 2026-07-21)
    data/videos.json
    data/timeline.json
    lib/schema.ts            types + validate(); imported by pages at build time
    layouts/Base.astro       html shell, meta defaults, header/footer
    components/
      Hero.astro
      VideoCard.astro
      VerificationBadge.astro   still on disk, unimported since 2026-07-21 — see design-spec.md §6
      TimelineEvent.astro
    pages/
      index.astro
      timeline.astro
      about.astro
      takedown.astro         corrections/takedown form (added 2026-07-21)
      404.astro
      video/[id].astro
    scripts/feed.ts          IntersectionObserver + scrubber + caption-expand logic (client)
  scripts/
    collect.mjs              (see content-pipeline.md)
    generate-samples.mjs     (see content-pipeline.md)
  archive-originals/         raw downloads, git-ignored
  wrangler.jsonc             now also declares main (src/worker.ts) and a d1_databases binding
  astro.config.mjs
  package.json
```

## 1. Scaffold

```sh
npm create astro@latest . -- --template minimal --typescript strict --no-git --no-install
npx astro add tailwind --yes
npm i
```

`astro.config.mjs`: `output: 'static'`, `site: 'https://20072026.com'`, add `@astrojs/sitemap` integration.

`wrangler.jsonc`:
```jsonc
{
  "name": "blackdays",
  "compatibility_date": "2026-07-21",
  "assets": { "directory": "./dist", "not_found_handling": "404-page" }
}
```

**Updated 2026-07-21 (commit `b8f0fdc`):** the live `wrangler.jsonc` now also has `main: "./src/worker.ts"` and the `assets` block carries a `binding: "ASSETS"`, plus a `d1_databases` entry (binding `TAKEDOWNS`, database `blackdays-takedowns`) — needed so `/api/takedown` has a Worker and a database to write to. See `docs/design-spec.md` §12 for the full corrections/takedowns architecture. The site is still a static build: when `assets` is configured alongside `main`, Cloudflare serves matching static files without invoking the Worker at all, so this costs nothing on ordinary page loads.

`package.json` scripts:
```json
{
  "dev": "astro dev",
  "build": "astro build",
  "deploy": "astro build && wrangler deploy",
  "samples": "node scripts/generate-samples.mjs",
  "collect": "node scripts/collect.mjs"
}
```

`.gitignore`: `node_modules`, `dist`, `archive-originals/`, `.wrangler`.

## 2. Data layer (`src/lib/schema.ts`)

- Export `interface VideoEntry` and `interface TimelineEvent` matching design-spec §5.
- Export `loadVideos()` / `loadTimeline()` that import the JSON, validate every entry (required fields present, `verificationStatus` in the 5-value union, id matches `/^video-\d{3}$/`, ids unique, no field equals `"TODO"` unless `sample === true`), and **throw with a descriptive message** on failure — this makes `astro build` fail on bad data.
- All pages get data through these two functions only.

`src/config.ts`:
```ts
export const SITE_NAME = "Black Days";
export const SITE_URL = "https://20072026.com";
export const MEDIA_BASE = "/media/";        // flip to https://media.20072026.com/ after R2 cutover
// No CONTACT_EMAIL constant. Removed 2026-07-21 (commit b8f0fdc): corrections
// and takedowns now go through the form at /takedown/ (src/pages/takedown.astro
// -> src/worker.ts -> D1), so no personal address is published on the site or
// committed to this public repository. See design-spec.md §12.
```

## 3. Layout & design tokens

`Base.astro` props: `title`, `description`, optional `ogImage`, optional `ogType`, optional `canonical`. Emits: charset/viewport, title (`{title} — Black Days`), meta description, canonical, OG (`og:site_name`, `og:title`, `og:description`, `og:image` absolute URL, `og:url`, `og:type`), `twitter:card=summary_large_image`, dark `color-scheme`.

Design tokens (Tailwind): background `#0a0a0b`, surface `#141416`, text `#e7e7ea`, muted `#9a9aa3`, accent `#c9a227` (restrained amber). System font stack. Max content column `max-w-xl mx-auto`. No animation beyond opacity/transform transitions ≤200ms; wrap all motion in `@media (prefers-reduced-motion: no-preference)`.

Header: site name (links `/`), nav: Feed · Timeline · About. Footer: one-line mission + contact + "archive, not endorsement" note.

## 4. Components

**`VerificationBadge.astro`** — prop `status`. Pill with dot + label. Colors (re-derived for the true-black theme, current values in `design-spec.md` §9): verified `#5fd88a`, likely-verified `#5eead4`, partially-verified `#fbbf24`, unverified `#e5e5e5`, context-unclear `#fb923c`. Labels: "Verified", "Likely verified", "Partially verified", "Unverified", "Context unclear". Includes a `title` attr with one-line meaning. **As of 2026-07-21 (commit `b8f0fdc`) this component is not imported by any page or component** — it was removed from the feed, `/video/[id]`, and `/about` in one pass. It is kept on disk rather than deleted; see `design-spec.md` §6 and `verification-policy.md` "Display rules" for the full history and rationale.

**`VideoCard.astro`** — props: `video: VideoEntry`, `index: number`. Instagram-main-feed-shaped structure (rebuilt 2026-07-21, commit `b8f0fdc`; supersedes the Reels-overlay/detail-link structure previously described here):
- `<article class="feed-card" data-video-src={MEDIA_BASE + video.media.video}>` sized to fill its scroll container, snap-aligned (`scroll-snap-align: start` on cards, `scroll-snap-type: y proximity` on the feed container).
- Post header: avatar monogram (first letter of `source.uploader`, no image assets), uploader handle, location.
- `<video playsinline muted loop preload="none" poster={thumbnail}>` — **no `src` attribute** on cards after the first; the feed script attaches it. Aspect from `media.width/height`.
- Mute button, play/pause glyph overlay, and an interactive progress-bar scrubber (`role="slider"`, 20px hit area over a 3px visible track — see `feed.ts` below) over the video.
- Meta row: **"View on {platform} ↗" links to `video.source.url`** (`target="_blank" rel="noopener noreferrer"`) — this replaced the old "Details →" link to `/video/{id}` — followed by the event date.
- Caption block: 2-line-clamped description behind a **"more" button** (not a link) that expands the caption in place rather than navigating to the video page; archived-date stamp.
- **No verification badge anywhere on the card.** If `video.sample` is true, `/video/[id]` (not the feed card) still shows a "Sample — placeholder entry" banner — no current entry sets this field.

**`Hero.astro`** — full-viewport section: site name large, one-paragraph mission (from design-spec §1, compressed), two links: "View timeline" and "About the archive", scroll cue (chevron, animated only under prefers-reduced-motion: no-preference). Static gradient/dark background — no hero video until real content exists.

**`TimelineEvent.astro`** — props: `event`, `videos` (resolved entries). Time (monospace), title, description, thumbnail links to each related video page. Vertical line connecting events (border-left).

## 5. Feed script (`src/scripts/feed.ts`)

Loaded once on the feed page via `<script>`. Logic:

1. `cards = document.querySelectorAll('.feed-card')`.
2. One `IntersectionObserver` (threshold `[0.6]`): entry ≥0.6 → `activate(card)`; below → `video.pause()`.
3. `activate(card)`: attach `src` from `data-video-src` if absent, `video.play().catch(() => {})`, and pre-attach `src` on the *next* card's video (no play). Never attach beyond current+next.
4. Click on video toggles `muted`; show a small speaker indicator. Keyboard: `tabindex="0"` on cards; Enter/Space toggles play/pause (preventDefault on Space).
5. If `matchMedia('(prefers-reduced-motion: reduce)')` → never autoplay; show native controls instead.

**Added 2026-07-21 (commit `b8f0fdc`), on top of the above:**

6. `setupProgressBar(card, video)`: wires the `.progress-hit` slider to pointer events (click-to-seek, drag-to-scrub via pointer capture, `touch-action: none` so a horizontal drag doesn't fight the feed's vertical scroll-snap) and to arrow-key nudging (±5s, `Home`/`End`). Keeps `aria-valuenow` in sync. Percentage is measured against the visible track's bounding rect, not the padded hit area, so the fill lines up under the pointer.
7. `setupMoreButton(card)`: measures (post-layout, and again on resize) whether the caption's `scrollHeight` exceeds its clamped `clientHeight`; only then reveals the "more" button. Clicking toggles `.is-expanded` and sets an inline `max-height` of ~30% of the card's own height so an unbounded caption can't push the video out of frame — the card's total height must stay fixed regardless of caption length.
8. The `.source-link` (platform name, linking to `video.source.url`) gets `stopPropagation()` on click so tapping it opens the original post in a new tab without also toggling play/pause on the card underneath.

## 6. Pages

**This section describes launch-day (2026-07-21 morning) scope.** Routing and page content evolved several times later the same day — `/` is now a scroll-storyline landing page (not `<Hero/>` + feed) and the feed lives at `/feed`; `design-spec.md` §7 has the up-to-date route table and the full history. What's below is corrected only where commit `b8f0fdc` changed it (badge removal, about-page rewrite, the new takedown page); it is not a complete re-description of current routing.

**`index.astro` / `/feed`** — feed container with `VideoCard` per entry (sorted by `date` desc, then id). Meta: site name + mission description, default OG image.

**`video/[id].astro`** — `getStaticPaths()` from `loadVideos()`. Renders: video with `controls preload="metadata"` poster (direct src — no observer here), title h1, full metadata block (event date, location, platform, uploader, original link `rel="noopener nofollow"`, archived date, duration), full description, tags. **No verification badge as of 2026-07-21** (commit `b8f0fdc` removed the `<VerificationBadge>` import and usage — see design-spec.md §6). Still renders a "Sample — placeholder entry" banner when `video.sample` is true; no current entry sets it. **Related videos**: score other entries = 2×(shared tags count) + (same date ? 1 : 0) + (same location ? 1 : 0); take top 4 with score > 0; render as thumbnail links. OG: title = video title, description = truncated description, image = absolute thumbnail URL, `og:type=video.other`.

**`timeline.astro`** — events from `loadTimeline()` sorted by time; `TimelineEvent` each, now also rendering each event's `sources` links when present (added 2026-07-21 — see design-spec.md §5).

**`about.astro`** — **rewritten 2026-07-21 (commit `b8f0fdc`).** Current sections: What this is (mission — the march, why the archive exists), Where the material comes from (participant footage prioritized over media-house coverage; attribution always kept), What this is not (explicitly: nothing has been independently verified — this replaces the old claim that the site "clearly distinguishes verified from unverified material"; also folds in the former non-goals and sample-content points), Timeline (links to `/timeline/`), Corrections & takedowns (a "Make a request" button linking to `/takedown/`). **Removed:** the "How verification works" section that listed all five statuses with a `VerificationBadge` per row, the `mailto:CONTACT_EMAIL` link, and a standalone "no likes" line.

**`takedown.astro`** — **added 2026-07-21.** See design-spec.md §12 for the full form/Worker/D1 architecture; not part of original launch-day scope.

**`404.astro`** — plain message + link home. Ensure a `404.html` lands in `dist/` (Astro emits `dist/404.html` for `src/pages/404.astro`; wrangler `not_found_handling: "404-page"` picks it up).

## 7. Scripts

Implement exactly per `content-pipeline.md`. Both start with a prereq check (`ffmpeg`; `collect.mjs` also `yt-dlp`) exiting with brew install hints. `generate-samples.mjs` must be idempotent (re-run overwrites sample media and sample entries, never touches non-sample entries). **As of 2026-07-21, `videos.json` has no sample entries** (the original eight and their media were deleted once real footage replaced them — five real entries, `video-009`…`video-013`, remain); `generate-samples.mjs` still works if sample entries are needed again (e.g. to demo the pipeline).

## 8. Deploy & verify (definition of done)

```sh
npm run build          # validation passes; dist/ has the feed, N video pages, timeline, about, takedown, 404, sitemap
npm run deploy         # wrangler deploy → prints the live URL
```

`N` was 8 at launch (all `sample: true` placeholders); as of 2026-07-21 it is 5 real entries (`video-009`…`video-013`) — adjust any hardcoded expectation in ad hoc verification commands accordingly.

Verify on the live URL:
- `curl -s <url>/feed/ | grep -c feed-card` → current video count (5 as of 2026-07-21).
- `curl -s <url>/video/video-009/ | grep 'og:image'` → absolute thumbnail URL.
- Browser (mobile viewport): scroll feed → autoplay/pause works, sound toggle works, scrubber seeks (needs a Range-capable server — see §11), "more" expands captions in place, source links open the original post in a new tab, video page plays, timeline renders with source citations, `/takedown/` submits with and without JavaScript, 404 for a bogus path.
- Lighthouse on `/`: expect ≥95 everywhere; fix regressions before calling it done.
- `npx wrangler d1 execute blackdays-takedowns --remote --command "SELECT * FROM takedown_requests ORDER BY created_at DESC"` → confirms a test takedown submission landed in D1.
- `node scripts/collect.mjs <a real public video URL>` → entry appended with TODO fields; then `npm run build` must **fail** on the TODOs (proves validation), remove the test entry afterward (or fill it in).

## 9. Cloudflare domain + R2 (after site is live on workers.dev)

1. `20072026.com` is already an active zone in the Cloudflare account — no new zone or nameserver change needed.
2. Add custom domain `20072026.com` to the Worker (dashboard: Worker → Settings → Domains & Routes, or `wrangler` routes).
3. Create R2 bucket `blackdays-media`; when real content lands: enable public access via custom domain `media.20072026.com`, upload `media/` tree, flip `MEDIA_BASE`, delete `public/media/`, redeploy.

## 10. Commit conventions

Commit at each numbered milestone (scaffold, data layer, components, pages, scripts, deploy config). Plain descriptive messages; no force-pushes.

## 11. Testing gotchas

Three traps that have each cost a previous session real debugging time. Read this before reporting anything as broken.

- **Never open `dist/` over `file://`.** Astro emits absolute `/_astro/*.css` paths. Under `file://` those resolve to filesystem root, not the site root, so the stylesheet 404s silently and every computed style is wrong. You will chase layout bugs that do not exist. Serve `dist/` over HTTP (`npx serve dist`, `python3 -m http.server` for anything that isn't video seeking — see below) or use `astro preview`.
- **Never verify the feed with the Chrome extension.** Its automation tab runs with `visibility: hidden`, which suppresses `IntersectionObserver` callbacks and blocks autoplay outright — the feed will appear completely non-functional (no autoplay, no card activation) even when it works fine for a real user. Use headless chromium (e.g. Playwright/Puppeteer) instead, which doesn't set that state.
- **Never test video seeking (the progress-bar scrubber, `design-spec.md` §8 / `src/scripts/feed.ts`) behind `python3 -m http.server`.** It does not implement HTTP Range requests, so `video.currentTime` silently refuses to move no matter what the scrubber does — a fully working scrubber will look broken. This one already produced an incorrect "the progress bar is broken" diagnosis in a previous session; the code was fine, the static server was the problem. Use a Range-capable server (`astro preview`, `npx serve`, or `wrangler dev`) when testing anything that seeks a `<video>`.
