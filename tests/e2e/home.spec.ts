import { expect, test } from "@playwright/test";

test("homepage renders the hero and primary nav", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/20\.07\.2026/);
  await expect(page.getByLabel("Home")).toBeVisible();
  await expect(page.getByLabel("Feed")).toBeVisible();
  await expect(page.getByLabel("Timeline")).toBeVisible();
  await expect(page.getByLabel("About")).toBeVisible();
});

test("never mentions sample/placeholder entries to visitors", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/sample placeholder/i)).toHaveCount(0);
});

test("submit-video form is present and toggles between url and upload mode", async ({ page }) => {
  await page.goto("/");
  const form = page.locator("#submit-video-form");
  await expect(form).toBeVisible();

  await expect(page.locator("#submit-video-url-field")).toBeVisible();
  await expect(page.locator("#submit-video-file-field")).toBeHidden();

  await page.locator('input[name="submit-mode"][value="upload"]').check();
  await expect(page.locator("#submit-video-file-field")).toBeVisible();
  await expect(page.locator("#submit-video-url-field")).toBeHidden();
});

// Regression tests for the 2026-07-28 upload incident: a real submitter's file
// was refused with a 413 and the form told them "Could not reach the server",
// so neither they nor the maintainer ever saw the actual reason. The upload
// PUT is stubbed here rather than driven for real — what's under test is how
// the form reports a response, not the Worker (tests/integration covers that).
test.describe("submit-video upload failures are reported honestly", () => {
  const COULD_NOT_REACH = /could not reach the server/i;

  async function startUpload(page: import("@playwright/test").Page) {
    await page.goto("/");
    await page.locator('input[name="submit-mode"][value="upload"]').check();
    await page.locator("#video-file").setInputFiles({
      name: "clip.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.from("not really a video, but the form never inspects it"),
    });
    // Stubbed so the test doesn't depend on (or write to) the local D1 row
    // that the real metadata step would create.
    await page.route("**/api/submit-video", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, id: 1 }),
      }),
    );
    return page.locator("#submit-video-status");
  }

  test("shows the server's own reason when the upload is refused", async ({ page }) => {
    const status = await startUpload(page);
    await page.route("**/api/upload/**", (route) =>
      route.fulfill({
        status: 413,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "That file is too large. The limit is 95MB." }),
      }),
    );

    await page.locator('#submit-video-form button[type="submit"]').click();
    await expect(status).toHaveText("That file is too large. The limit is 95MB.");
    await expect(status).not.toHaveText(COULD_NOT_REACH);
  });

  test("falls back to a status-specific message when the body isn't the Worker's JSON", async ({
    page,
  }) => {
    const status = await startUpload(page);
    // What Cloudflare's edge actually returns for an over-plan-limit body: an
    // HTML error page, generated before the Worker is ever invoked.
    await page.route("**/api/upload/**", (route) =>
      route.fulfill({
        status: 413,
        contentType: "text/html",
        body: "<html><body>413 Request Entity Too Large</body></html>",
      }),
    );

    await page.locator('#submit-video-form button[type="submit"]').click();
    await expect(status).toContainText(/too large/i);
    await expect(status).not.toHaveText(COULD_NOT_REACH);
  });

  test("still reports a genuine connection failure as one", async ({ page }) => {
    const status = await startUpload(page);
    await page.route("**/api/upload/**", (route) => route.abort("connectionfailed"));

    await page.locator('#submit-video-form button[type="submit"]').click();
    await expect(status).toHaveText(COULD_NOT_REACH);
  });
});
