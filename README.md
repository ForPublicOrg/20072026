# Black Days — blackdays.in

A static archive documenting publicly available videos, photos, and reporting related to a specific protest event. Preservation, discoverability, and historical documentation — with attribution always preserved and verification status always shown. No backend, no accounts, no comments.

## Documentation

Read in this order:

1. [`docs/design-spec.md`](docs/design-spec.md) — what we're building and every decision made (architecture, data model, pages, design language).
2. [`docs/implementation-guide.md`](docs/implementation-guide.md) — **step-by-step build instructions** for launch day: scaffold commands, file tree, component specs, deploy & verification checklist.
3. [`docs/execution-plan.md`](docs/execution-plan.md) — phased roadmap beyond launch day.
4. [`docs/content-pipeline.md`](docs/content-pipeline.md) — how media gets from a public URL into the archive.
5. [`docs/verification-policy.md`](docs/verification-policy.md) — criteria for the five verification statuses.

`initial-doc.md` is the original idea document; where it and `design-spec.md` differ, the design spec wins.

## Quickstart (once implemented)

```sh
npm i
npm run samples                  # generate placeholder content (needs ffmpeg)
npm run dev                      # local dev
npm run collect -- <public-url>  # add a real video (needs yt-dlp + ffmpeg)
npm run deploy                   # build + deploy to Cloudflare Workers
```

## Stack

Astro (static) · TypeScript · Tailwind CSS · Cloudflare Workers static assets · Cloudflare R2 (media) · yt-dlp + ffmpeg (local collection pipeline)

## Principles

Static always. Build-time over runtime. JSON over databases. Minimal JavaScript. Attribution preserved. Verification status explicit. One maintainer can run everything.
