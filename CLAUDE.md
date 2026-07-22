# blackdays (20072026.com)

A protest-documentation archive: Astro static site + a narrow Cloudflare Worker (`src/worker.ts`, handles only `POST /api/takedown`) on Cloudflare Workers with static assets. D1 (`TAKEDOWNS` binding) is a private correction/takedown inbox — never rendered on the public site. Media (video/thumbnails) is served from R2 at `media.20072026.com`. **Live domain is `20072026.com`** — `blackdays.in` is referenced in some docs as an eventual destination but is not wired up; don't treat it as production.

## Reading order

`README.md` → `docs/design-spec.md` → `docs/implementation-guide.md` → `docs/execution-plan.md` → `docs/content-pipeline.md` → `docs/verification-policy.md`.

## Deploy model

Deploys are CI-driven, not manual:
- Open a PR against `main` → GitHub Actions builds and deploys to an isolated **staging** Worker (`blackdays-staging`) + staging D1 database (`blackdays-takedowns-staging`) at `staging.20072026.com`, and comments the preview URL on the PR.
- Merge to `main` → GitHub Actions deploys **production** (`blackdays`, `blackdays-takedowns`) at `20072026.com`.

Staging is a real custom-domain route (`staging.20072026.com`) on the zone we already own, not a `*.workers.dev` URL — this account has deliberately never registered a workers.dev subdomain (permanent, account-wide once created), and staging isn't meant to be what triggers that.

Do not run `npm run deploy` / `wrangler deploy` against production as the normal path — it bypasses CI, and D1 migrations are applied by the CI pipeline, not by hand. Use `npm run deploy:staging` only for a local one-off smoke test against the staging Worker. Full runbook (first-time setup, day-to-day flow, verification, rollback): **`.claude/skills/deploy/SKILL.md`** — read it before deploying, rolling back, or onboarding a new contributor.

Secrets/config for CI live as GitHub Environment secrets (`CLOUDFLARE_API_TOKEN`, scoped separately per `staging`/`production` environment) and a repo-level Actions variable (`CLOUDFLARE_ACCOUNT_ID`) — never in `.env` files or committed anywhere.

## Local setup

- `npm i`
- `lefthook install` (once) — activates the `gitleaks protect --staged` pre-commit hook (`lefthook.yml`, `.gitleaks.toml`)
- `gitleaks` itself isn't an npm package — install separately (e.g. `brew install gitleaks`)

## Content-authoring gotchas (detail in `docs/content-pipeline.md`)

- Build validation rejects any `videos.json`/`timeline.json` entry still containing a literal `TODO` field — fill every field before merging.
- `scripts/collect.mjs` still writes new media to `public/media/`, which is stale/unserved since the R2 cutover. New media must be pushed to R2 by hand: `wrangler r2 object put blackdays-media/... --file ... --remote`.
