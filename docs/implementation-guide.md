# Black Days — Implementation Guide

Step-by-step build instructions for launch day. Written so any engineer (or model) can execute without re-deriving decisions. Read `design-spec.md` first; this doc is the "how".

## 0. Target file tree

```
blackdays/
  docs/                      (already written)
  public/
    media/videos/            sample clips (git-ignored ok if regenerable)
    media/thumbnails/
    favicon.svg
  src/
    config.ts                MEDIA_BASE, SITE_URL, SITE_NAME, contact email
    data/videos.json
    data/timeline.json
    lib/schema.ts            types + validate(); imported by pages at build time
    layouts/Base.astro       html shell, meta defaults, header/footer
    components/
      Hero.astro
      VideoCard.astro
      VerificationBadge.astro
      TimelineEvent.astro
    pages/
      index.astro
      timeline.astro
      about.astro
      404.astro
      video/[id].astro
    scripts/feed.ts          IntersectionObserver logic (client)
  scripts/
    collect.mjs              (see content-pipeline.md)
    generate-samples.mjs     (see content-pipeline.md)
  archive-originals/         raw downloads, git-ignored
  wrangler.jsonc
  astro.config.mjs
  package.json
```

## 1. Scaffold

```sh
npm create astro@latest . -- --template minimal --typescript strict --no-git --no-install
npx astro add tailwind --yes
npm i
```

`astro.config.mjs`: `output: 'static'`, `site: 'https://blackdays.in'`, add `@astrojs/sitemap` integration.

`wrangler.jsonc`:
```jsonc
{
  "name": "blackdays",
  "compatibility_date": "2026-07-21",
  "assets": { "directory": "./dist", "not_found_handling": "404-page" }
}
```

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
export const SITE_URL = "https://blackdays.in";
export const MEDIA_BASE = "/media/";        // flip to https://media.blackdays.in/ after R2 cutover
export const CONTACT_EMAIL = "rajtalekar24@gmail.com"; // corrections & takedowns
```

## 3. Layout & design tokens

`Base.astro` props: `title`, `description`, optional `ogImage`, optional `ogType`, optional `canonical`. Emits: charset/viewport, title (`{title} — Black Days`), meta description, canonical, OG (`og:site_name`, `og:title`, `og:description`, `og:image` absolute URL, `og:url`, `og:type`), `twitter:card=summary_large_image`, dark `color-scheme`.

Design tokens (Tailwind): background `#0a0a0b`, surface `#141416`, text `#e7e7ea`, muted `#9a9aa3`, accent `#c9a227` (restrained amber). System font stack. Max content column `max-w-xl mx-auto`. No animation beyond opacity/transform transitions ≤200ms; wrap all motion in `@media (prefers-reduced-motion: no-preference)`.

Header: site name (links `/`), nav: Feed · Timeline · About. Footer: one-line mission + contact + "archive, not endorsement" note.

## 4. Components

**`VerificationBadge.astro`** — prop `status`. Pill with dot + label. Colors (muted): verified `#3f6f4f`, likely-verified `#3d6a6a`, partially-verified `#7a6a35`, unverified `#4a4a52`, context-unclear `#7a5a35`. Labels: "Verified", "Likely verified", "Partially verified", "Unverified", "Context unclear". Include `title` attr with one-line meaning.

**`VideoCard.astro`** — props: `video: VideoEntry`, `index: number`. Structure:
- `<article class="feed-card" data-video-src={MEDIA_BASE + video.media.video}>` min-height ≈ `100svh`, snap-aligned (`scroll-snap-align: start` on cards, `scroll-snap-type: y proximity` on the feed container).
- `<video playsinline muted loop preload="none" poster={thumbnail}>` — **no `src` attribute**; the feed script attaches it. Aspect from `media.width/height`.
- If `video.sample`: absolutely-positioned banner "SAMPLE — placeholder entry" top of card.
- Below video: title (h2, links to `/video/{id}`), row: platform · uploader · event date, tag pills, `VerificationBadge`, 2-line-clamped description, "Details →" link to the video page.

**`Hero.astro`** — full-viewport section: site name large, one-paragraph mission (from design-spec §1, compressed), two links: "View timeline" and "About the archive", scroll cue (chevron, animated only under prefers-reduced-motion: no-preference). Static gradient/dark background — no hero video until real content exists.

**`TimelineEvent.astro`** — props: `event`, `videos` (resolved entries). Time (monospace), title, description, thumbnail links to each related video page. Vertical line connecting events (border-left).

## 5. Feed script (`src/scripts/feed.ts`)

Loaded once on `index.astro` via `<script>`. Logic:

1. `cards = document.querySelectorAll('.feed-card')`.
2. One `IntersectionObserver` (threshold `[0.6]`): entry ≥0.6 → `activate(card)`; below → `video.pause()`.
3. `activate(card)`: attach `src` from `data-video-src` if absent, `video.play().catch(() => {})`, and pre-attach `src` on the *next* card's video (no play). Never attach beyond current+next.
4. Click on video toggles `muted`; show a small speaker indicator. Keyboard: `tabindex="0"` on cards; Enter/Space toggles play/pause (preventDefault on Space).
5. If `matchMedia('(prefers-reduced-motion: reduce)')` → never autoplay; show native controls instead.

## 6. Pages

**`index.astro`** — `<Hero/>` then feed container with `VideoCard` per entry (sorted by `date` desc, then id). Meta: site name + mission description, default OG image (generate a simple 1200×630 dark PNG with the site name into `public/og-default.png`; a script or one-off ffmpeg/ImageMagick command is fine).

**`video/[id].astro`** — `getStaticPaths()` from `loadVideos()`. Renders: video with `controls preload="metadata"` poster (direct src — no observer here), title h1, full metadata block (event date, location, platform, uploader, original link `rel="noopener nofollow"`, archived date, duration), badge, full description, tags. **Related videos**: score other entries = 2×(shared tags count) + (same date ? 1 : 0) + (same location ? 1 : 0); take top 4 with score > 0; render as thumbnail links. OG: title = video title, description = truncated description, image = absolute thumbnail URL, `og:type=video.other`.

**`timeline.astro`** — events from `loadTimeline()` sorted by time; `TimelineEvent` each; intro sentence stating timeline entries follow the same verification policy.

**`about.astro`** — sections: What this is (mission), What this is not (non-goals: no accounts/comments/uploads), How verification works (5 statuses, one line each + note that full policy is in the repo), Sources & attribution (always preserved, links to originals), Corrections & takedowns (CONTACT_EMAIL), Sample-content notice (present until real content replaces it).

**`404.astro`** — plain message + link home. Ensure a `404.html` lands in `dist/` (Astro emits `dist/404.html` for `src/pages/404.astro`; wrangler `not_found_handling: "404-page"` picks it up).

## 7. Scripts

Implement exactly per `content-pipeline.md`. Both start with a prereq check (`ffmpeg`; `collect.mjs` also `yt-dlp`) exiting with brew install hints. `generate-samples.mjs` must be idempotent (re-run overwrites sample media and sample entries, never touches non-sample entries).

## 8. Deploy & verify (definition of done)

```sh
npm run samples        # sample media + data exist
npm run build          # validation passes; dist/ has index, 8 video pages, timeline, about, 404, sitemap
npm run deploy         # wrangler deploy → prints https://blackdays.<account>.workers.dev
```

Verify on the live URL:
- `curl -s <url>/ | grep -c feed-card` → 8.
- `curl -s <url>/video/video-001/ | grep 'og:image'` → absolute thumbnail URL.
- Browser (mobile viewport): scroll feed → autoplay/pause works, sound toggle works, video page plays, timeline renders, 404 for a bogus path.
- Lighthouse on `/`: expect ≥95 everywhere; fix regressions before calling it done.
- `node scripts/collect.mjs <a real public video URL>` → entry appended with TODO fields; then `npm run build` must **fail** on the TODOs (proves validation), remove the test entry afterward (or fill it in).

## 9. Cloudflare domain + R2 (after site is live on workers.dev)

1. Add zone `blackdays.in` to the Cloudflare account (free plan) → note the two assigned nameservers.
2. **User action at Namecheap:** Domain → Nameservers → Custom DNS → enter the two Cloudflare nameservers.
3. Once the zone is active: add custom domain `blackdays.in` (and `www` redirect) to the Worker (dashboard: Worker → Settings → Domains & Routes, or `wrangler` routes).
4. Create R2 bucket `blackdays-media`; when real content lands: enable public access via custom domain `media.blackdays.in`, upload `media/` tree, flip `MEDIA_BASE`, delete `public/media/`, redeploy.

## 10. Commit conventions

Commit at each numbered milestone (scaffold, data layer, components, pages, scripts, deploy config). Plain descriptive messages; no force-pushes.
