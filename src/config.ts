// Plain-text form: used in <title>, meta tags, OG/Twitter cards, the web
// manifest, and anywhere middots would be unsafe or just noise (feeds,
// share-card renderers). The dotted display wordmark (20·07·2026) is styled
// separately where the site name renders visually — see Base.astro.
export const SITE_NAME = "20.07.2026";
// Keep in sync with `site` in astro.config.mjs — this drives absolute OG image
// and canonical URLs. Flip to https://blackdays.in once that zone is live.
export const SITE_URL = "https://20072026.com";
export const MEDIA_BASE = "/media/";        // flip to https://media.blackdays.in/ after R2 cutover
export const CONTACT_EMAIL = "rajtalekar24@gmail.com"; // corrections & takedowns
