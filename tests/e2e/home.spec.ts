import { expect, test } from "@playwright/test";

test("homepage renders the hero and primary nav", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/20\.07\.2026/);
  await expect(page.getByLabel("Home")).toBeVisible();
  await expect(page.getByLabel("Feed")).toBeVisible();
  await expect(page.getByLabel("Timeline")).toBeVisible();
  await expect(page.getByLabel("About")).toBeVisible();
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
