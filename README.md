# Black Days — 20072026.com

A static archive documenting publicly available videos, photos, and reporting related to a specific protest event. Preservation, discoverability, and historical documentation — with attribution always preserved and verification status always shown. No backend, no accounts, no comments.

## Documentation

Read in this order:

1. [`docs/design-spec.md`](docs/design-spec.md) — what this is and how it's built: architecture, data model, pages, the Worker/D1/R2 backend, design language.
2. [`docs/execution-plan.md`](docs/execution-plan.md) — current status and what's still ahead.
3. [`docs/content-pipeline.md`](docs/content-pipeline.md) — how media gets from a public URL (or a public submission) into the archive.
4. [`docs/verification-policy.md`](docs/verification-policy.md) — criteria for the five verification statuses.

`initial-doc.md` is the original idea document; where it and `design-spec.md` differ, the design spec wins.

## Quickstart

```sh
npm i
npm run dev                      # local dev
npm run collect -- <public-url>  # add a real video (needs yt-dlp + ffmpeg)
npm test                         # unit + integration + e2e (see CLAUDE.md "Testing")
```

Deploys are CI-driven, not run by hand from this quickstart — see `CLAUDE.md` "Deploy model" and `.claude/skills/deploy/SKILL.md`.

## Stack

Astro (static) · TypeScript · Tailwind CSS · Cloudflare Workers (static assets + a narrow API for takedowns/submissions) · Cloudflare D1 (private request inboxes) · Cloudflare R2 (media + pending uploads) · yt-dlp + ffmpeg (local collection pipeline)

## Principles

Static always. Build-time over runtime. JSON over databases. Minimal JavaScript. Attribution preserved. Verification status explicit. One maintainer can run everything.
