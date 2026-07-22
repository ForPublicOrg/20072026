import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// Picks whatever the first real archive entry is rather than hardcoding an
// id — video ids get retired/added over time, and this test shouldn't need
// updating every time content changes. Read via fs rather than a JSON import
// so this file doesn't need Node's `with { type: "json" }` import attribute.
const videosPath = fileURLToPath(new URL("../../src/data/videos.json", import.meta.url));
const videos = JSON.parse(readFileSync(videosPath, "utf-8")) as Array<{
  id: string;
  title: string;
}>;
const video = videos[0];

test("individual video page renders with correct OG tags for link previews", async ({ page }) => {
  await page.goto(`/video/${video.id}/`);

  await expect(page.locator("h1")).toContainText(video.title);

  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    "content",
    new RegExp(video.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  await expect(page.locator('meta[property="og:type"]')).toHaveAttribute("content", /.+/);
  const ogImage = page.locator('meta[property="og:image"]');
  await expect(ogImage).toHaveAttribute("content", /^https?:\/\//);
  const ogUrl = page.locator('meta[property="og:url"]');
  await expect(ogUrl).toHaveAttribute("content", new RegExp(`/video/${video.id}/?$`));
});

test("unknown video id 404s", async ({ page }) => {
  const res = await page.goto("/video/video-does-not-exist/");
  expect(res?.status()).toBe(404);
});
