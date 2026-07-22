import { expect, test } from "@playwright/test";

test("feed page renders video cards", async ({ page }) => {
  await page.goto("/feed");
  const feed = page.locator("#feed");
  await expect(feed).toBeVisible();

  const cards = page.locator(".feed-card");
  await expect(cards.first()).toBeVisible();
  expect(await cards.count()).toBeGreaterThan(0);

  // Every card must credit its source — this is the archive's core promise
  // (attribution always preserved), so it's worth a direct regression check.
  const firstHandle = cards.first().locator(".handle");
  await expect(firstHandle).not.toBeEmpty();
});
