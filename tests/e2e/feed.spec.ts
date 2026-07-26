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

// .serial: e2e tests run against one shared local D1 (via wrangler dev) with
// nothing clearing video_likes between tests (unlike the integration suite's
// beforeEach), and playwright.config.ts runs fullyParallel across two
// projects. Combined with shuffleFeedOrder() below randomizing which video
// lands as "the first card" on every load, two parallel workers could land
// on the same video id and corrupt each other's count assertions — the
// settled count always comes from the server's real aggregate, not just
// client-side math. Serial execution removes that concurrency window
// entirely, without needing per-test DB isolation.
test.describe.serial("like feature", () => {
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

  // This directly encodes the bug report that triggered Task 11: before that
  // fix, both taps of a double-tap independently toggled playback (so a
  // double-tap on a playing video paused it, then the like burst played on
  // top of a now-paused video). Task 11 made single-tap play/pause deferred
  // and cancellable, so a confirmed double-tap must never touch `paused` at
  // all -- not "ends up right eventually", but literally unchanged start to
  // finish.
  test("double-tapping does not change the video's playing state at all", async ({ page }) => {
    const { likeBtn, video } = await openFirstCard(page);

    // Wait for autoplay to settle into a definite state before capturing the
    // "before" snapshot -- otherwise a still-resolving initial play()
    // promise could flip `paused` on its own between the snapshot and the
    // final assertion, which would look identical to a real regression.
    await expect
      .poll(() => video.evaluate((el) => (el as HTMLVideoElement).paused))
      .toBe(false);
    const pausedBefore = await video.evaluate((el) => (el as HTMLVideoElement).paused);

    await video.click();
    await video.click();

    // Confirms the burst/like path actually ran (i.e. this was registered as
    // a real double-tap), not two independent single taps that happened to
    // land far apart.
    await expect(likeBtn).toHaveAttribute("data-liked", "true");

    // feed.ts's TAP_WINDOW_MS is 280ms -- wait comfortably past it so a
    // wrongly-still-pending single-tap timer would have had every chance to
    // fire and flip playback before this reads the final state.
    await page.waitForTimeout(500);

    const pausedAfter = await video.evaluate((el) => (el as HTMLVideoElement).paused);
    expect(pausedAfter).toBe(pausedBefore);
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

  // Forces the like/unlike request to fail, to exercise the rollback path in
  // feed.ts: both likeVideo() and the .like-btn click handler apply the
  // optimistic update synchronously, then revert data-liked/.like-count back
  // to their pre-action values in the catch (or the `!data.ok` branch). The
  // route is registered only after openFirstCard() has resolved, since it
  // also matches GET /api/likes/batch (the hydration fetch) via the same
  // "**/api/likes/**" glob — forcing that to fail too would leave
  // data-hydrated stuck at "false" and openFirstCard's own wait would hang.
  test("a failed like request rolls back the optimistic update (double-tap)", async ({ page }) => {
    const { likeBtn, video, count } = await openFirstCard(page);
    const before = await readCount(count);
    const likedBefore = (await likeBtn.getAttribute("data-liked")) ?? "false";

    await page.route("**/api/likes/**", async (route) => {
      // Delay the forced failure slightly so the optimistic update below is
      // observably in place before it reverts — without this, a same-tick
      // response could resolve before the "instant update" assertion gets a
      // chance to see the pre-revert state.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "test-forced failure" }),
      });
    });

    await video.click();
    await video.click();

    // Optimistic update applies instantly, well ahead of the delayed
    // failure response above.
    await expect(likeBtn).toHaveAttribute("data-liked", "true");
    await expect(count).toHaveText(String(before + 1));

    // Once the forced-failure response resolves, likeVideo()'s catch path
    // must revert both data-liked and .like-count back to their pre-action
    // values — not just avoid crashing.
    await expect(likeBtn).toHaveAttribute("data-liked", likedBefore);
    await expect(count).toHaveText(String(before));
  });

  test("a failed like request rolls back the optimistic update (like button click)", async ({
    page,
  }) => {
    const { likeBtn, count } = await openFirstCard(page);
    const before = await readCount(count);
    await expect(likeBtn).toHaveAttribute("data-liked", "false");

    await page.route("**/api/likes/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "test-forced failure" }),
      });
    });

    await likeBtn.click();

    // Optimistic update from the .like-btn click handler, applied instantly
    // ahead of the delayed failure response.
    await expect(likeBtn).toHaveAttribute("data-liked", "true");
    await expect(count).toHaveText(String(before + 1));

    // Once the forced failure resolves, the click handler's catch path must
    // revert both data-liked and .like-count back to their pre-click values.
    await expect(likeBtn).toHaveAttribute("data-liked", "false");
    await expect(count).toHaveText(String(before));
  });

  // Task 10: feed.ts's positionLikeButton() relocates the single .like-btn
  // DOM node between two slots based on viewport width, rather than
  // rendering two buttons and hiding one. Viewport must be set before
  // navigation, since positionLikeButton() reads DESKTOP_MQL.matches
  // synchronously during initFeed() on page load.
  test("at a mobile viewport, the like button overlays the video (.like-slot-overlay)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { card, likeBtn } = await openFirstCard(page);

    // Unambiguous placement check: the button must resolve as a descendant
    // of the overlay slot (itself inside .video-wrap) and NOT be present in
    // the row slot at all -- not just "exists somewhere on the page".
    await expect(card.locator(".video-wrap .like-slot-overlay .like-btn")).toHaveCount(1);
    await expect(card.locator(".like-slot-row .like-btn")).toHaveCount(0);
    await expect(likeBtn).toHaveClass(/is-overlay/);
  });

  test("at a desktop viewport, the like button stays in its own row (.like-slot-row)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const { card, likeBtn } = await openFirstCard(page);

    // Mirror image of the mobile check above: row slot holds it, overlay
    // slot (inside .video-wrap) is empty, and it never carries the
    // mobile-only overlay styling class.
    await expect(card.locator(".like-slot-row .like-btn")).toHaveCount(1);
    await expect(card.locator(".video-wrap .like-slot-overlay .like-btn")).toHaveCount(0);
    await expect(likeBtn).not.toHaveClass(/is-overlay/);
  });
});
