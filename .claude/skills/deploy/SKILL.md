---
name: deploy
description: Use when deploying the 20072026.com site, onboarding a new contributor, verifying a staging or production deploy, or rolling back a bad production deploy.
---

# Deploy

Deploys are driven entirely by GitHub Actions (`.github/workflows/deploy.yml`), not by hand:
PR against `main` → auto-deploy to staging → merge to `main` → auto-deploy to production.

## 1. First-time contributor setup

- `npm i`
- `lefthook install` — one-time, activates the `gitleaks protect --staged` pre-commit hook
- Install `gitleaks` separately (`brew install gitleaks`; it's a Go binary, not an npm package)
- `gh auth login` — needed to open PRs
- `wrangler login` — only needed for local commands below (`d1 execute`, `tail`); CI does not use your local login

Never run `wrangler deploy` (no `--env`) as your normal workflow — that deploys straight to production, outside CI, and skips the D1 migration step CI runs for you.

## 2. One-time repo/infra setup (already done — reference record)

- [x] `wrangler d1 create blackdays-takedowns-staging` → `database_id` filled into `wrangler.jsonc`'s `env.staging.d1_databases[0]`
- [x] `wrangler d1 migrations apply blackdays-takedowns-staging --env staging --remote`
- [ ] Two Cloudflare API tokens created (dashboard → My Profile → API Tokens): a staging token and a production token, **both** needing Account D1:Edit, Account Workers Scripts:Edit, Zone Workers Routes:Edit and Zone:Read on `20072026.com` — staging needs the zone permissions too because `staging.20072026.com` is a real custom-domain route on that zone (see note below on why it's not a workers.dev URL)
- [ ] GitHub Environments `staging` / `production` created; `CLOUDFLARE_API_TOKEN` set as a secret in each
- [ ] Repo-level Actions variable `CLOUDFLARE_ACCOUNT_ID` set
- [x] `.github/workflows/deploy.yml` added

### "Submit a video" feature (link + raw upload) — added 2026-07-23

- [x] `wrangler d1 create blackdays-video-submissions` → `database_id` (`e666f211-8490-4646-805a-4710ebff88d9`) filled into `wrangler.jsonc`'s top-level `d1_databases`
- [x] `wrangler d1 create blackdays-video-submissions-staging` → `database_id` (`8de76959-33bc-4f15-9b14-2df7bd2754f7`) filled into `wrangler.jsonc`'s `env.staging.d1_databases`
- [x] `wrangler d1 migrations apply` run by hand once against both of the above (`--remote` / `--env staging --remote`) so local/manual testing has schema immediately; CI will also run this on every deploy going forward (no-op until a new migration file is added)
- [x] `wrangler r2 bucket create blackdays-uploads` (production, private — no custom domain)
- [x] `wrangler r2 bucket create blackdays-uploads-staging` (staging, private — kept separate from production, unlike the shared read-only `blackdays-media`)
- [x] Both real `database_id`s added to `.gitleaks.toml`'s allowlist regexes, same as the existing `blackdays-takedowns` id
- [ ] **Both Cloudflare API tokens need an added permission**: Account **Workers R2 Storage:Edit** — the checklist above only ever granted D1/Workers Scripts/Zone permissions, and `wrangler deploy` will fail to bind the new `UPLOADS` R2 bucket without this. **Could not be done by Claude** — the Cloudflare API MCP tool available in this environment returned "Unauthorized to access requested resource" on `/accounts/{account_id}/tokens`, meaning its credential can't read or edit API tokens (a deliberate restriction, not a bug). This is a manual dashboard step: My Profile → API Tokens → edit both the staging and production tokens.

**Why staging is `staging.20072026.com` and not a `*.workers.dev` URL:** this Cloudflare account has never registered a workers.dev subdomain — that was deliberately skipped when the site was first set up, since it's a one-time, permanent, account-wide registration. Staging deliberately doesn't trigger it either; it uses a second custom-domain route on the zone you already own instead.

If any unchecked item is still open, CI will fail on `deploy-staging`/`deploy-production` with an auth or missing-var error — finish those before relying on this flow.

## 3. Day-to-day flow

1. Branch off `main`, make changes, commit (pre-commit hook runs gitleaks automatically)
2. `git push`, `gh pr create` targeting `main`
3. CI builds and deploys to `blackdays-staging`; check the PR for a "Staging deploy ready" comment with the preview URL
4. Verify on staging (commands below) — including that a test takedown submission lands in `blackdays-takedowns-staging`, and a test video submission (link or upload) lands in `blackdays-video-submissions-staging` / `blackdays-uploads-staging` — **never** the production table/bucket
5. Merge the PR
6. CI deploys production automatically; verify prod the same way

## 4. Verification commands

```sh
# OG tags
curl -s https://staging.20072026.com/ | grep -i 'og:'   # or https://20072026.com/ for prod

# D1 rows (staging)
npx wrangler d1 execute blackdays-takedowns-staging --env staging --remote \
  --command "select * from takedown_requests order by id desc limit 5"

# D1 rows (production)
npx wrangler d1 execute blackdays-takedowns --remote \
  --command "select * from takedown_requests order by id desc limit 5"

# Video submissions (staging / production) — or use the friendlier
# `node scripts/admin-requests.mjs list --type video [--env staging]`
npx wrangler d1 execute blackdays-video-submissions-staging --env staging --remote \
  --command "select * from video_submissions order by id desc limit 5"
npx wrangler d1 execute blackdays-video-submissions --remote \
  --command "select * from video_submissions order by id desc limit 5"

# Live logs
npx wrangler tail blackdays-staging   # or: npx wrangler tail blackdays
```

`scripts/admin-requests.mjs` wraps the `d1 execute`/`r2 object get` commands above for day-to-day triage of both inboxes (list/export, update status, download an approved raw upload) — see its header comment for full usage. It authenticates via the same local `wrangler login` session as everything else here; it never touches a token or password.

## 5. Rollback

- Fast path: `npx wrangler rollback --name blackdays` (or `--name blackdays-staging`) — reverts to the previously deployed version without a rebuild
- Otherwise: revert the bad commit on `main` and push — CI redeploys automatically
- D1 has no down-migrations here — fix a bad migration forward with a new migration file, don't try to undo one

## 6. Gotchas (full detail in `docs/content-pipeline.md`)

- Build validation rejects any content entry still containing a literal `TODO` field
- `scripts/collect.mjs` writes new media to `public/media/`, which is stale/unserved since the R2 cutover — push new media manually: `wrangler r2 object put blackdays-media/<key> --file <path> --remote`
- The `blackdays-media` R2 bucket is intentionally shared between staging and production (read-only reference content, ~667MB) — don't duplicate it
- gitleaks blocks commits with secret-shaped strings; non-secret Cloudflare resource IDs (like D1 `database_id`s) go in `.gitleaks.toml`'s allowlist rather than disabling the hook
