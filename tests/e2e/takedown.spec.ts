import { expect, test } from "@playwright/test";

// This is the single most important flow to protect against regressions in:
// it's the archive's only way for a real person to reach the maintainer, and
// it exercises the full stack for real — browser -> Worker (src/worker.ts)
// -> D1 -> back to the page, with no mocking.
test("takedown form submits successfully end to end", async ({ page }) => {
  await page.goto("/takedown/");

  await page.locator("#kind").selectOption("other");
  await page
    .locator("#message")
    .fill("Playwright e2e test submission — safe to ignore/delete.");

  await page.locator("#takedown-form button[type=submit]").click();

  await expect(page.locator("#form-status")).toHaveText(
    "Request received. Thank you — this will be reviewed.",
  );
});

test("takedown form shows a client-side validation error for a too-short message", async ({
  page,
}) => {
  await page.goto("/takedown/");

  await page.locator("#kind").selectOption("other");
  await page.locator("#message").fill("short");
  await page.locator("#takedown-form button[type=submit]").click();

  // The native `minlength` constraint blocks submission before it reaches
  // the network — the request should never fire, and the status line should
  // stay empty (no server round trip happened).
  await expect(page.locator("#form-status")).toHaveText("");
});
