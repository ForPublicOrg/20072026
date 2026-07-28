/**
 * Single source of truth for the raw-upload size cap.
 *
 * Imported by BOTH `src/worker.ts` (server-side validation, both steps of the
 * two-step upload) and `src/pages/index.astro` (the pre-flight check and the
 * user-facing copy). Kept in one module deliberately: before 2026-07-28 the
 * number was written out separately in the Worker, the page script, the page
 * markup, and docs/design-spec.md, and raising or lowering it meant finding
 * all four.
 *
 * This file must stay free of Cloudflare- and DOM-specific types — it is
 * bundled into the browser as well as the Worker.
 */

/**
 * Per-file cap for raw footage uploads.
 *
 * MUST stay below the account's Cloudflare plan request-body limit. That limit
 * is enforced at the edge and returns a 413 *before* the Worker is invoked, so
 * no amount of server-side handling can turn it into a useful error message:
 * https://developers.cloudflare.com/workers/platform/limits/#request-limits
 *
 *   Free 100MB · Pro 100MB · Business 200MB · Enterprise 500MB (default)
 *
 * This zone is on the Free plan, so the ceiling is 100MB; 95MB leaves headroom
 * for request headers.
 *
 * History: this was 250MB until 2026-07-28. Any file between 100MB and 250MB
 * therefore passed the client pre-flight check AND the Worker's step-1
 * validation, got a `video_submissions` row, and was then killed at the edge on
 * `PUT /api/upload/:id` — leaving an orphaned row with a NULL `r2_key` while the
 * submitter saw only a generic connection error. Two real submissions were lost
 * that way (rows 30 and 31) before it was caught.
 *
 * Before raising this, check the zone's *current* plan — not this comment.
 */
export const MAX_UPLOAD_BYTES = 95 * 1024 * 1024;

/**
 * Human-readable form of {@link MAX_UPLOAD_BYTES}, for user-facing copy. Lives
 * next to the constant so the number quoted to submitters can't drift from the
 * number actually enforced.
 */
export const MAX_UPLOAD_LABEL = `${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))}MB`;

/** The single wording used whenever a file is rejected for being too large. */
export const TOO_LARGE_MESSAGE = `That file is too large. The limit is ${MAX_UPLOAD_LABEL}.`;
