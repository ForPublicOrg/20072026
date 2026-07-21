// Plain-text form: used in <title>, meta tags, OG/Twitter cards, the web
// manifest, and anywhere middots would be unsafe or just noise (feeds,
// share-card renderers). The dotted display wordmark (20·07·2026) is styled
// separately where the site name renders visually — see Base.astro.
export const SITE_NAME = "20.07.2026";
// Keep in sync with `site` in astro.config.mjs — this drives absolute OG image
// and canonical URLs. blackdays.in is not a zone in this Cloudflare account;
// 20072026.com is the real, live domain (see `routes` in wrangler.jsonc).
export const SITE_URL = "https://20072026.com";
// R2 cutover complete (2026-07-21): media now served from the custom domain
// bound to the `blackdays-media` R2 bucket, not from public/media/.
export const MEDIA_BASE = "https://media.20072026.com/";
// No contact email constant by design. Corrections and takedowns go through
// the form at /takedown/, which posts to a Worker and stores requests in D1 —
// so the maintainer's personal address is never published on a public page.
