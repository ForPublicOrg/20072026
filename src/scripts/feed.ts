// Feed autoplay + native reels-style interaction behavior for the homepage
// feed. See docs/implementation-guide.md §5 / docs/design-spec.md §8.
//
// Interaction map (deliberately Instagram/TikTok-shaped, not "website"):
//   - tap on the video           -> play/pause (with a fading centre glyph)
//   - dedicated mute button      -> mute/unmute, persists across cards
//   - Enter/Space on focused card -> play/pause
//   - ArrowUp/ArrowDown           -> move focus + snap-scroll to prev/next card
//   - progress bar (role=slider) -> click/drag to seek, arrow keys to nudge
//   - "more" button               -> expands the caption in place (no nav)
//   - platform name in meta row  -> opens the original post in a new tab
//
// Scale discipline: `src` is attached only for the current card and the
// next one; every other card is detached. This is what lets the archive
// grow to thousands of entries without the homepage degrading, and it must
// not regress.

const ACTIVATE_THRESHOLD = 0.6;
const MUTE_IDLE_MS = 2000;

// Stable per-browser id sent as x-client-id on like/unlike so the server can
// enforce one like per client without accounts. Persisted in localStorage
// (not cookies/sessionStorage) so it survives reloads and tab close/reopen.
const CLIENT_ID_KEY = "bd_client_id";

function getClientId(): string {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

// GET /api/likes/batch returns counts only (edge-cached, no per-client data)
// after a Cloudflare architecture review — so "have I liked this video" is
// tracked entirely client-side in this set, never round-tripped from the
// server. It lives in the same localStorage as bd_client_id and is allowed
// to live and die with it: if localStorage is cleared, the old client id's
// server-side likes become unreachable anyway, so losing the local liked-set
// at the same time isn't a new inconsistency.
const LIKED_SET_KEY = "bd_liked_videos";

function getLikedSet(): Set<string> {
  try {
    const raw = localStorage.getItem(LIKED_SET_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function setLiked(videoId: string, liked: boolean) {
  const set = getLikedSet();
  if (liked) set.add(videoId);
  else set.delete(videoId);
  localStorage.setItem(LIKED_SET_KEY, JSON.stringify([...set]));
}

// Persisted across cards: once a user unmutes, the next video they scroll
// to should also be audible.
let globalMuted = true;

// Mobile overlays .like-btn on the video's bottom-right corner (Reels-style,
// above the mute button); desktop keeps it as its own row below the video —
// the site's existing non-overlay principle, deliberately excepted for
// mobile only (see VideoCard.astro's top comment). The threshold mirrors
// .card-frame's own 768px breakpoint in VideoCard.astro. A single shared
// MediaQueryList (not one per card) backs the live-resize listener below,
// same pattern as globalMuted above being one piece of cross-card state
// rather than per-card state.
const DESKTOP_MQL = matchMedia("(min-width: 768px)");

// Relocates the SAME .like-btn DOM node between its two possible slots
// (never clones/duplicates it) based on the current breakpoint. Desktop:
// moved into .like-slot-row, its server-rendered default position, own row
// below the video. Mobile: moved into .like-slot-overlay, a descendant of
// .video-wrap positioned exactly like .mute-btn, so it renders as a real
// overlay over the footage rather than being pushed around by flex sizing.
function positionLikeButton(card: HTMLElement) {
  const likeBtn = card.querySelector<HTMLButtonElement>(".like-btn");
  const overlaySlot = card.querySelector<HTMLElement>(".like-slot-overlay");
  const rowSlot = card.querySelector<HTMLElement>(".like-slot-row");
  if (!likeBtn || !overlaySlot || !rowSlot) return;

  if (DESKTOP_MQL.matches) {
    rowSlot.appendChild(likeBtn);
    likeBtn.classList.remove("is-overlay");
  } else {
    overlaySlot.appendChild(likeBtn);
    likeBtn.classList.add("is-overlay");
  }
}

// initFeed() re-runs on every astro:page-load (view-transition nav included,
// see the listener at the bottom of this file), each time against a fresh
// `cards` array. DESKTOP_MQL itself is module-level and outlives any single
// page-load, so without this the "one shared listener" would actually become
// one-shared-listener-per-navigation, each closing over an increasingly
// stale `cards` array. Tracking + removing the previous listener here keeps
// it to exactly one live listener, closed over the current cards, at a time.
let removeDesktopMqlListener: (() => void) | null = null;

const muteIdleTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

function updateMuteUI(card: HTMLElement, muted: boolean) {
  const btn = card.querySelector<HTMLButtonElement>(".mute-btn");
  if (!btn) return;
  btn.dataset.muted = String(muted);
  btn.setAttribute("aria-pressed", String(muted));
  btn.setAttribute("aria-label", muted ? "Unmute video" : "Mute video");
}

function wakeMuteButton(card: HTMLElement) {
  const btn = card.querySelector<HTMLButtonElement>(".mute-btn");
  if (!btn) return;
  btn.classList.remove("is-idle");
  const existing = muteIdleTimers.get(card);
  if (existing) clearTimeout(existing);
  muteIdleTimers.set(
    card,
    setTimeout(() => btn.classList.add("is-idle"), MUTE_IDLE_MS),
  );
}

function showGlyph(card: HTMLElement, icon: "play" | "pause") {
  const glyph = card.querySelector<HTMLElement>(".play-glyph");
  if (!glyph) return;
  glyph.classList.remove("show");
  glyph.dataset.icon = icon;
  // Force reflow so re-adding "show" restarts the fade animation even if
  // the user taps repeatedly in quick succession.
  void glyph.offsetWidth;
  glyph.classList.add("show");
}

function togglePlayPause(video: HTMLVideoElement, card: HTMLElement) {
  if (video.paused) {
    video.play().catch(() => {});
    showGlyph(card, "play");
  } else {
    video.pause();
    showGlyph(card, "pause");
  }
}

function attachSrc(video: HTMLVideoElement, card: HTMLElement) {
  if (video.dataset.attached === "true") return;
  const src = card.dataset.videoSrc;
  if (!src) return;
  video.src = src;
  video.dataset.attached = "true";
}

function detachSrc(video: HTMLVideoElement) {
  if (video.dataset.attached !== "true") return;
  video.pause();
  video.removeAttribute("src");
  video.load();
  delete video.dataset.attached;
}

// Seekable progress bar: click/tap to jump, drag (pointer events, works for
// mouse and touch alike) to scrub live, arrow keys to nudge. `role="slider"`
// on the hit-area element makes this a real control for AT, so it needs
// aria-valuenow kept in sync and to be independently focusable/keyboard-
// operable, not just pointer-operable.
const SEEK_STEP_SECONDS = 5;

function setupProgressBar(card: HTMLElement, video: HTMLVideoElement) {
  const hit = card.querySelector<HTMLElement>(".progress-hit");
  const track = card.querySelector<HTMLElement>(".progress-track");
  const fill = card.querySelector<HTMLElement>(".progress-fill");
  if (!hit || !track || !fill) return;

  function applyPct(pct: number) {
    const clamped = Math.min(1, Math.max(0, pct));
    fill.style.width = `${clamped * 100}%`;
    hit!.setAttribute("aria-valuenow", String(Math.round(clamped * 100)));
  }

  // Percentage is measured against the *visible* track, not the padded hit
  // area, so the fill lines up under the pointer even though the hit area
  // extends well above/below the 3px bar for touch purposes.
  function pctFromEvent(event: PointerEvent): number {
    const rect = track!.getBoundingClientRect();
    if (rect.width === 0) return 0;
    return (event.clientX - rect.left) / rect.width;
  }

  function seekToPct(pct: number) {
    if (!video.duration || Number.isNaN(video.duration)) return;
    const clamped = Math.min(1, Math.max(0, pct));
    video.currentTime = clamped * video.duration;
    applyPct(clamped);
  }

  hit.addEventListener("pointerdown", (event: PointerEvent) => {
    event.stopPropagation();
    hit.dataset.scrubbing = "true";
    hit.setPointerCapture(event.pointerId);
    seekToPct(pctFromEvent(event));
  });

  hit.addEventListener("pointermove", (event: PointerEvent) => {
    if (hit.dataset.scrubbing !== "true") return;
    event.stopPropagation();
    seekToPct(pctFromEvent(event));
  });

  function endScrub(event: PointerEvent) {
    if (hit!.dataset.scrubbing !== "true") return;
    event.stopPropagation();
    delete hit!.dataset.scrubbing;
    if (hit!.hasPointerCapture(event.pointerId)) {
      hit!.releasePointerCapture(event.pointerId);
    }
  }

  hit.addEventListener("pointerup", endScrub);
  hit.addEventListener("pointercancel", endScrub);

  // pointerdown already seeks, so a plain click needs no handling of its
  // own — it's only stopped here so it can never reach the video's click
  // (play/pause) or the card's other listeners.
  hit.addEventListener("click", (event) => event.stopPropagation());

  hit.addEventListener("keydown", (event: KeyboardEvent) => {
    if (!video.duration || Number.isNaN(video.duration)) return;
    let nextTime: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      nextTime = Math.min(video.duration, video.currentTime + SEEK_STEP_SECONDS);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      nextTime = Math.max(0, video.currentTime - SEEK_STEP_SECONDS);
    } else if (event.key === "Home") {
      nextTime = 0;
    } else if (event.key === "End") {
      nextTime = video.duration;
    }
    if (nextTime === null) return;
    // Must stop here, not just preventDefault: ArrowUp/ArrowDown are also
    // the card's own between-video navigation keys (see the card-level
    // keydown handler below), and without stopPropagation a press on the
    // focused slider would both seek AND snap-scroll to the next card.
    event.preventDefault();
    event.stopPropagation();
    video.currentTime = nextTime;
    applyPct(video.duration ? video.currentTime / video.duration : 0);
  });

  video.addEventListener("timeupdate", () => {
    // While the user is actively dragging, the pointer handlers above are
    // the source of truth for both the seek and the fill width — letting
    // this rAF/timeupdate-driven paint run concurrently would fight the
    // drag (the video's currentTime lags the pointer until the seek
    // actually lands, so the fill would visibly jitter backwards).
    if (hit.dataset.scrubbing === "true") return;
    if (!video.duration || Number.isNaN(video.duration)) return;
    applyPct(video.currentTime / video.duration);
  });
}

// "more" expands the caption in place instead of navigating to the detail
// page. The button is hidden by default in markup and only revealed here
// once we can measure that the caption is actually being clipped by the
// 2-line clamp — a short caption should never show a "more" that does
// nothing.
function setupMoreButton(card: HTMLElement) {
  const caption = card.querySelector<HTMLElement>(".caption");
  const btn = card.querySelector<HTMLButtonElement>(".more-link");
  if (!caption || !btn) return;

  function measure() {
    if (caption!.classList.contains("is-expanded")) return;
    const isClamped = caption!.scrollHeight > caption!.clientHeight + 1;
    btn!.hidden = !isClamped;
  }

  // Measured after layout (line-clamp height depends on the rendered card
  // width), and re-measured on resize since rotating the device can push a
  // caption across the clamp threshold in either direction.
  requestAnimationFrame(measure);
  window.addEventListener("resize", measure);

  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    const expanded = caption.classList.toggle("is-expanded");
    btn.setAttribute("aria-expanded", String(expanded));
    btn.textContent = expanded ? "less" : "more";
    if (expanded) {
      // Bounded to a fraction of the CARD's own height, not a fixed px or
      // a CSS percentage — .caption-block's ancestor chain isn't
      // percentage-sized down to .feed-card, and .card-frame is a fixed-
      // height flex column with overflow: hidden, so an unbounded caption
      // would either get clipped outright or push the video out of frame.
      // Scrolling *inside* the caption keeps the card's total height fixed
      // no matter how long the description is (video-010 is long).
      const cardHeight = card.getBoundingClientRect().height;
      caption.style.maxHeight = `${Math.round(cardHeight * 0.3)}px`;
    } else {
      caption.style.maxHeight = "";
    }
  });
}

// Shared by hydration, the optimistic update on tap/click, and reconciling
// with whatever the server actually persisted — a single place that keeps
// the button's data-liked/aria-pressed and its count text in sync.
// `hydrated` gates the CSS that hides .like-count until a real count is
// known (see VideoCard.astro), so it must stay false for the synchronous,
// pre-fetch pass in hydrateLikes and true everywhere else.
function applyLikeState(card: HTMLElement, liked: boolean, count: number, hydrated: boolean) {
  const btn = card.querySelector<HTMLButtonElement>(".like-btn");
  if (!btn) return;
  btn.dataset.liked = String(liked);
  btn.setAttribute("aria-pressed", String(liked));
  if (hydrated) btn.dataset.hydrated = "true";
  const countEl = btn.querySelector<HTMLElement>(".like-count");
  if (countEl) countEl.textContent = String(count);
}

function showLikeBurst(card: HTMLElement) {
  const burst = card.querySelector<HTMLElement>(".like-burst");
  if (!burst) return;
  burst.classList.remove("show");
  // Force reflow so re-adding "show" restarts the fade animation even on a
  // repeat double-tap of an already-liked video (see the "already liked"
  // early-return below — the burst still has to replay every time).
  void burst.offsetWidth;
  burst.classList.add("show");
}

// Double-tap path: always ends in liked=true. Idempotent by design — a
// repeat double-tap on an already-liked video replays the burst (visual
// confirmation the tap registered) but never calls the network or bumps the
// count again. Only the .like-btn handler below can unlike.
async function likeVideo(card: HTMLElement) {
  const btn = card.querySelector<HTMLButtonElement>(".like-btn");
  const videoId = card.dataset.videoId;
  if (!btn || !videoId || btn.dataset.pending === "true") return;

  showLikeBurst(card);

  if (btn.dataset.liked === "true") return; // already liked: burst only, no network call, no re-count

  btn.dataset.pending = "true";
  const countEl = btn.querySelector<HTMLElement>(".like-count");
  const prevCount = Number(countEl?.textContent ?? "0");
  applyLikeState(card, true, prevCount + 1, true);

  try {
    const res = await fetch(`/api/likes/${encodeURIComponent(videoId)}`, {
      method: "POST",
      headers: { "x-client-id": getClientId() },
    });
    if (!res.ok) throw new Error(`like failed: ${res.status}`);
    const data = (await res.json()) as { ok: boolean; liked: boolean; count: number };
    if (data.ok) {
      applyLikeState(card, data.liked, data.count, true);
      setLiked(videoId, data.liked);
    } else {
      applyLikeState(card, false, prevCount, true);
    }
  } catch (error) {
    console.error("like failed", error);
    applyLikeState(card, false, prevCount, true);
  } finally {
    delete btn.dataset.pending;
  }
}

function setupCardInteractions(
  card: HTMLElement,
  cards: HTMLElement[],
  index: number,
  prefersReducedMotion: boolean,
) {
  const video = card.querySelector<HTMLVideoElement>("video");
  if (!video) return;

  // Reflect the persisted global mute preference immediately, even before
  // this card becomes active.
  video.muted = globalMuted;
  updateMuteUI(card, globalMuted);

  // Double-tap-to-like defers the single-tap play/pause decision until we
  // know a second tap isn't coming (Instagram-shaped), rather than firing
  // togglePlayPause unconditionally on every click. That's a deliberate
  // trade-off, confirmed with the user: single-tap play/pause becomes
  // ~250-300ms slower, always, in exchange for double-tap never touching
  // playback at all — the previous "fire immediately, count after the fact"
  // approach always toggled playback on both taps of a double-tap, which is
  // the bug this replaces.
  const TAP_WINDOW_MS = 280; // Instagram-like window; single-tap play/pause is now deferred by up to this long

  let tapCount = 0;
  let tapTimer: ReturnType<typeof setTimeout> | null = null;

  video.addEventListener("click", () => {
    wakeMuteButton(card); // harmless UI nicety, stays immediate/unconditional on every tap

    if (prefersReducedMotion) {
      togglePlayPause(video, card); // no double-tap gesture in this mode, so no need to defer
      return;
    }

    tapCount++;
    if (tapCount === 1) {
      tapTimer = setTimeout(() => {
        tapCount = 0;
        togglePlayPause(video, card); // confirmed single tap: commit the deferred play/pause now
      }, TAP_WINDOW_MS);
    } else if (tapCount === 2) {
      if (tapTimer) clearTimeout(tapTimer);
      tapCount = 0;
      likeVideo(card); // confirmed double tap: like only — playback state is never touched
    }
  });

  const muteBtn = card.querySelector<HTMLButtonElement>(".mute-btn");
  muteBtn?.addEventListener("click", (event) => {
    event.stopPropagation();
    globalMuted = !video.muted;
    video.muted = globalMuted;
    updateMuteUI(card, globalMuted);
    wakeMuteButton(card);
  });

  card.addEventListener("pointerdown", () => wakeMuteButton(card));

  setupProgressBar(card, video);
  setupMoreButton(card);

  // Real toggle (unlike double-tap, this is the only path that can unlike):
  // POST when currently unliked, DELETE when currently liked, both against
  // the same idempotent /api/likes/:id route the double-tap path uses.
  const likeBtn = card.querySelector<HTMLButtonElement>(".like-btn");
  likeBtn?.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (!likeBtn || likeBtn.dataset.pending === "true") return;
    const videoId = card.dataset.videoId;
    if (!videoId) return;

    const wasLiked = likeBtn.dataset.liked === "true";
    const countEl = likeBtn.querySelector<HTMLElement>(".like-count");
    const prevCount = Number(countEl?.textContent ?? "0");

    likeBtn.dataset.pending = "true";
    applyLikeState(card, !wasLiked, wasLiked ? prevCount - 1 : prevCount + 1, true);
    if (!wasLiked) showLikeBurst(card);

    try {
      const res = await fetch(`/api/likes/${encodeURIComponent(videoId)}`, {
        method: wasLiked ? "DELETE" : "POST",
        headers: { "x-client-id": getClientId() },
      });
      if (!res.ok) throw new Error(`like toggle failed: ${res.status}`);
      const data = (await res.json()) as { ok: boolean; liked: boolean; count: number };
      if (data.ok) {
        applyLikeState(card, data.liked, data.count, true);
        setLiked(videoId, data.liked);
      } else {
        applyLikeState(card, wasLiked, prevCount, true);
      }
    } catch (error) {
      console.error("like toggle failed", error);
      applyLikeState(card, wasLiked, prevCount, true);
    } finally {
      delete likeBtn.dataset.pending;
    }
  });

  // The source link opens the original post in a new tab; it must not also
  // toggle play/pause on the card underneath it (same reasoning as the mute
  // button above).
  const sourceLink = card.querySelector<HTMLAnchorElement>(".source-link");
  sourceLink?.addEventListener("click", (event) => event.stopPropagation());

  card.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      togglePlayPause(video, card);
      wakeMuteButton(card);
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const target = cards[index + delta];
      if (!target) return;
      target.scrollIntoView({
        behavior: prefersReducedMotion ? "auto" : "smooth",
        block: "start",
      });
      target.focus({ preventScroll: true });
    }
  });
}

function setupReducedMotion(cards: HTMLElement[]) {
  cards.forEach((card) => {
    const video = card.querySelector<HTMLVideoElement>("video");
    if (!video) return;
    card.classList.add("is-native-controls");
    const src = card.dataset.videoSrc;
    if (src) {
      video.src = src;
      video.dataset.attached = "true";
    }
    video.controls = true;
    video.removeAttribute("loop");
    video.muted = false;
  });
}

function activate(card: HTMLElement, cards: HTMLElement[], index: number) {
  const video = card.querySelector<HTMLVideoElement>("video");
  if (!video) return;

  attachSrc(video, card);
  video.muted = globalMuted;
  updateMuteUI(card, globalMuted);
  video.play().catch(() => {});

  const next = cards[index + 1];
  if (next) {
    const nextVideo = next.querySelector<HTMLVideoElement>("video");
    if (nextVideo) attachSrc(nextVideo, next);
  }

  cards.forEach((otherCard, otherIndex) => {
    if (otherIndex === index) return;
    const otherVideo = otherCard.querySelector<HTMLVideoElement>("video");
    if (!otherVideo) return;
    otherVideo.pause();
    if (otherIndex !== index + 1) {
      detachSrc(otherVideo);
    }
  });
}

// Randomizes discovery order on every visit, within two priority tiers:
// participant (raw) footage first, then everything else — each tier shuffled
// independently, then concatenated tier-first. The feed is a static build
// (no per-request server), so this has to happen client-side, and it has to
// run before .feed-card is queried below: everything downstream — next/prev
// via cards[index ± 1], the IntersectionObserver, attach/detach of `src` —
// keys off DOM order, so reordering later would desync it from what's on
// screen. Reassigns each card via appendChild, which *moves* an
// already-attached node rather than cloning it, so listeners bound
// afterward in this same pass are unaffected.
function shuffleFeedOrder(container: HTMLElement) {
  const cards = Array.from(container.children) as HTMLElement[];
  const participant = cards.filter((c) => c.dataset.footageOrigin === "participant");
  const rest = cards.filter((c) => c.dataset.footageOrigin !== "participant");
  for (const group of [participant, rest]) {
    for (let i = group.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [group[i], group[j]] = [group[j], group[i]];
    }
  }
  for (const card of [...participant, ...rest]) container.appendChild(card);

  // `container` has `scroll-snap-type: y mandatory` (see feed.astro's
  // .feed style). Reordering its children via appendChild while scrolled to
  // 0 does NOT keep scrollTop at 0: the browser keeps whichever card was
  // snapped-to *before* the reorder (the pre-shuffle first card, i.e.
  // whatever feed.astro's build-time sort put first) scrolled into view at
  // its new, post-shuffle position — landing the user deep in the list on
  // a fixed card instead of at the top. Confirmed via manual reproduction;
  // unaffected by `overflow-anchor: none` (a different, unrelated
  // mechanism) or by toggling scroll-snap-type off for the mutation.
  // Forcing scrollTop back to 0 one frame later, after layout has settled
  // from the reorder, is what actually sticks.
  container.scrollTop = 0;
  requestAnimationFrame(() => {
    container.scrollTop = 0;
  });
}

// Two-phase: liked/unliked state is applied synchronously from the local
// set (no network wait needed for it), then counts are filled in once the
// batch fetch resolves. Counts start hidden via data-hydrated="false" (see
// VideoCard.astro's .like-btn[data-hydrated="false"] .like-count rule) so
// the page never flashes a wrong or zeroed count before the real numbers
// arrive.
async function hydrateLikes(cards: HTMLElement[]) {
  const likedSet = getLikedSet();
  for (const card of cards) {
    applyLikeState(card, likedSet.has(card.dataset.videoId ?? ""), 0, false);
  }
  try {
    const res = await fetch("/api/likes/batch");
    if (!res.ok) throw new Error(`batch fetch failed: ${res.status}`);
    const data = (await res.json()) as { ok: boolean; likes: Record<string, number> };
    if (!data.ok) return;
    // Re-read the liked set here rather than reusing the pre-fetch snapshot
    // above: a double-tap or .like-btn click can complete (and call
    // setLiked()) while this fetch is still in flight, since both listeners
    // are attached before the fetch resolves. Reusing the stale snapshot
    // would silently revert that just-made optimistic change back to
    // whatever it was before the user acted.
    const freshLikedSet = getLikedSet();
    for (const card of cards) {
      const id = card.dataset.videoId;
      if (!id) continue;
      // If a like/unlike is still in flight for this card right now, leave
      // it alone -- that request's own .then/finally is the thing that
      // settles its final state, and reconciling here too could still race
      // it even with the fresh read above (the fetch could resolve between
      // the read and this loop reaching the card).
      const btn = card.querySelector<HTMLButtonElement>(".like-btn");
      if (btn?.dataset.pending === "true") continue;
      applyLikeState(card, freshLikedSet.has(id), data.likes[id] ?? 0, true);
    }
  } catch (error) {
    console.error("like hydration failed", error);
  }
}

function initFeed() {
  const feedEl = document.getElementById("feed");
  if (feedEl) shuffleFeedOrder(feedEl);

  const cards = Array.from(
    document.querySelectorAll<HTMLElement>(".feed-card"),
  );
  if (cards.length === 0) return;

  const prefersReducedMotion = matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  cards.forEach((card, index) => {
    setupCardInteractions(card, cards, index, prefersReducedMotion);
    positionLikeButton(card);
  });

  removeDesktopMqlListener?.();
  const onBreakpointChange = () => cards.forEach(positionLikeButton);
  DESKTOP_MQL.addEventListener("change", onBreakpointChange);
  removeDesktopMqlListener = () =>
    DESKTOP_MQL.removeEventListener("change", onBreakpointChange);

  // Fire-and-forget: hydration is async and independent of interaction
  // setup below, so it must not block the rest of initFeed (autoplay
  // observer, reduced-motion fallback) behind a network round-trip.
  void hydrateLikes(cards);

  if (prefersReducedMotion) {
    setupReducedMotion(cards);
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const card = entry.target as HTMLElement;
        const index = cards.indexOf(card);
        if (index === -1) continue;
        const video = card.querySelector<HTMLVideoElement>("video");
        if (!video) continue;

        if (entry.intersectionRatio >= ACTIVATE_THRESHOLD) {
          activate(card, cards, index);
        } else {
          video.pause();
        }
      }
    },
    { threshold: [ACTIVATE_THRESHOLD] },
  );

  cards.forEach((card) => observer.observe(card));
}

// astro:page-load (not DOMContentLoaded) because Base.astro renders
// <ClientRouter />: navigating here from another in-app link swaps the
// document without a full reload, so DOMContentLoaded won't fire again and
// this setup — including the reshuffle above — would silently only ever run
// once per browser session. astro:page-load fires both on a real first load
// and after every subsequent view-transition navigation, so this single
// listener covers both without double-running on the initial load the way
// pairing it with an immediate call would.
document.addEventListener("astro:page-load", initFeed);
