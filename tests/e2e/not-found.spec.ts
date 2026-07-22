import { expect, test } from "@playwright/test";

test("unknown paths render the 404 page", async ({ page }) => {
  const res = await page.goto("/this-page-does-not-exist");
  expect(res?.status()).toBe(404);
  await expect(page.locator("h1")).toHaveText("404");
});
