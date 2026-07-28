import { describe, expect, it } from "vitest";
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_LABEL,
  TOO_LARGE_MESSAGE,
} from "../../src/lib/upload-limits";

/**
 * Regression guard for the 2026-07-28 upload incident.
 *
 * The advertised cap was 250MB while the zone's Cloudflare plan refuses any
 * request body over 100MB — and it refuses it at the edge, returning a 413
 * before the Worker runs. Nothing in src/worker.ts can observe that, so no
 * server-side test can catch it either; the only defence is asserting the
 * constant itself stays under the plan ceiling.
 *
 * If this test fails because the cap was raised deliberately, confirm the
 * zone's *current* plan and update CLOUDFLARE_PLAN_BODY_LIMIT below to match —
 * do not simply widen the assertion.
 */
describe("upload size cap", () => {
  // Free and Pro both cap request bodies at 100MB; Business is 200MB and
  // Enterprise defaults to 500MB. 20072026.com is on Free.
  // https://developers.cloudflare.com/workers/platform/limits/#request-limits
  const CLOUDFLARE_PLAN_BODY_LIMIT = 100 * 1024 * 1024;

  it("stays below the Cloudflare plan's edge-enforced request-body limit", () => {
    expect(MAX_UPLOAD_BYTES).toBeLessThan(CLOUDFLARE_PLAN_BODY_LIMIT);
  });

  it("leaves headroom for request headers rather than sitting exactly on the limit", () => {
    expect(CLOUDFLARE_PLAN_BODY_LIMIT - MAX_UPLOAD_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
  });

  it("is still large enough to be worth offering", () => {
    expect(MAX_UPLOAD_BYTES).toBeGreaterThanOrEqual(50 * 1024 * 1024);
  });

  it("quotes the enforced number in the copy shown to submitters", () => {
    expect(MAX_UPLOAD_LABEL).toBe("95MB");
    expect(TOO_LARGE_MESSAGE).toContain(MAX_UPLOAD_LABEL);
    // A file of exactly the advertised size must actually be accepted.
    const advertised = Number(MAX_UPLOAD_LABEL.replace("MB", "")) * 1024 * 1024;
    expect(advertised).toBeLessThanOrEqual(MAX_UPLOAD_BYTES);
  });
});
