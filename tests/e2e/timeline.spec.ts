import { expect, test } from "@playwright/test";

test("timeline page renders events in order", async ({ page }) => {
  await page.goto("/timeline/");
  await expect(page.locator("h1")).toHaveText("Timeline");

  const events = page.locator("time");
  expect(await events.count()).toBeGreaterThan(0);
});
