import { expect, test, type Locator, type Page } from "@playwright/test";

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

test.describe("like feature", () => {
  // shuffleFeedOrder() (feed.ts) randomizes card order on every load, so
  // there's no stable "first video" across tests/loads — but within a single
  // test, .first() always resolves to the same DOM node, which is all these
  // tests need. Kept as a helper so every test waits on the same hydration
  // condition before touching .like-count.
  async function openFirstCard(page: Page): Promise<{
    card: Locator;
    likeBtn: Locator;
    video: Locator;
    count: Locator;
  }> {
    await page.goto("/feed");
    const feed = page.locator("#feed");
    await expect(feed).toBeVisible();

    const card = page.locator(".feed-card").first();
    await expect(card).toBeVisible();

    const likeBtn = card.locator(".like-btn");
    // Counts hydrate asynchronously via GET /api/likes/batch (see
    // hydrateLikes in src/scripts/feed.ts). Before that resolves,
    // data-hydrated is "false" and .like-count holds a placeholder "0" —
    // reading it earlier than this wait would be a race, not a real
    // assertion.
    await expect(likeBtn).toHaveAttribute("data-hydrated", "true");

    return {
      card,
      likeBtn,
      video: card.locator(".card-video"),
      count: likeBtn.locator(".like-count"),
    };
  }

  async function readCount(count: Locator): Promise<number> {
    return Number((await count.textContent()) ?? "0");
  }

  test("double-tapping a card's video likes it", async ({ page }) => {
    const { likeBtn, video, count } = await openFirstCard(page);
    const before = await readCount(count);

    // Two `.click()` calls back-to-back with no artificial delay between
    // them — comfortably inside feed.ts's 300ms DOUBLE_TAP_WINDOW_MS, since
    // each call resolves in well under that once the element is already
    // visible and stable (as it is here, post-hydration).
    await video.click();
    await video.click();

    await expect(likeBtn).toHaveAttribute("data-liked", "true");
    await expect(count).toHaveText(String(before + 1));
  });

  test("repeating the double-tap on the same card does not like it again", async ({ page }) => {
    const { likeBtn, video, count } = await openFirstCard(page);
    const before = await readCount(count);

    await video.click();
    await video.click();
    await expect(likeBtn).toHaveAttribute("data-liked", "true");
    await expect(count).toHaveText(String(before + 1));

    // Second double-tap on the same, already-liked card. feed.ts's
    // likeVideo() early-returns once data-liked is already "true" (it still
    // replays the burst animation, but makes no network call and never
    // re-counts) — this is that idempotency guarantee exercised end to end,
    // not just asserted against the source.
    await video.click();
    await video.click();

    await expect(likeBtn).toHaveAttribute("data-liked", "true");
    await expect(count).toHaveText(String(before + 1));
  });

  test("a single click on the video does not like it, and still toggles play/pause", async ({ page }) => {
    const { likeBtn, video, count } = await openFirstCard(page);
    const before = await readCount(count);
    const likedBefore = await likeBtn.getAttribute("data-liked");

    // The active card autoplays once it intersects the viewport (feed.ts's
    // IntersectionObserver -> activate()). Confirm it's actually playing
    // first, so the assertion below (paused becomes true) can't pass by
    // accident on a video that never started.
    await expect
      .poll(() => video.evaluate((el) => (el as HTMLVideoElement).paused))
      .toBe(false);

    await video.click();

    // This is the safety-critical regression guard: a single tap must pause
    // the video exactly as before, completely unaffected by the double-tap
    // counter layered on top of it in feed.ts.
    await expect
      .poll(() => video.evaluate((el) => (el as HTMLVideoElement).paused))
      .toBe(true);
    await expect(likeBtn).toHaveAttribute("data-liked", likedBefore ?? "false");
    await expect(count).toHaveText(String(before));
  });

  test("clicking the like button toggles data-liked and moves the count by exactly one", async ({
    page,
  }) => {
    const { likeBtn, count } = await openFirstCard(page);
    const before = await readCount(count);
    // Fresh browser context per test => empty localStorage => this client
    // has never liked anything yet, so every card starts unliked.
    await expect(likeBtn).toHaveAttribute("data-liked", "false");

    await likeBtn.click();
    await expect(likeBtn).toHaveAttribute("data-liked", "true");
    await expect(count).toHaveText(String(before + 1));

    await likeBtn.click();
    await expect(likeBtn).toHaveAttribute("data-liked", "false");
    await expect(count).toHaveText(String(before));
  });

  test("with reduced motion, the like button still works and double-tapping the video does not like it", async ({
    page,
  }) => {
    // Must be set before navigation so matchMedia("(prefers-reduced-motion:
    // reduce)") already reads true when initFeed() runs on page load.
    await page.emulateMedia({ reducedMotion: "reduce" });

    const { likeBtn, video, count } = await openFirstCard(page);
    const before = await readCount(count);

    // Reduced-motion users get no double-tap gesture at all — feed.ts skips
    // registering the tap counter entirely when prefersReducedMotion is
    // true, rather than just suppressing the burst animation.
    await video.click();
    await video.click();
    await expect(likeBtn).toHaveAttribute("data-liked", "false");
    await expect(count).toHaveText(String(before));

    await expect(likeBtn).toBeVisible();
    await expect(likeBtn).toBeEnabled();
    await likeBtn.click();
    await expect(likeBtn).toHaveAttribute("data-liked", "true");
    await expect(count).toHaveText(String(before + 1));
  });
});
