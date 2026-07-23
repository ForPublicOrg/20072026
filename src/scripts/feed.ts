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

// Persisted across cards: once a user unmutes, the next video they scroll
// to should also be audible.
let globalMuted = true;

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

  video.addEventListener("click", () => {
    togglePlayPause(video, card);
    wakeMuteButton(card);
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

  cards.forEach((card, index) =>
    setupCardInteractions(card, cards, index, prefersReducedMotion),
  );

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
