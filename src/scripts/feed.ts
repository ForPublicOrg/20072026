// Feed autoplay + native reels-style interaction behavior for the homepage
// feed. See docs/implementation-guide.md §5 / docs/design-spec.md §8.
//
// Interaction map (deliberately Instagram/TikTok-shaped, not "website"):
//   - tap on the video           -> play/pause (with a fading centre glyph)
//   - dedicated mute button      -> mute/unmute, persists across cards
//   - Enter/Space on focused card -> play/pause
//   - ArrowUp/ArrowDown           -> move focus + snap-scroll to prev/next card
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

  video.addEventListener("timeupdate", () => {
    const fill = card.querySelector<HTMLElement>(".progress-fill");
    if (!fill || !video.duration || Number.isNaN(video.duration)) return;
    const pct = Math.min(100, (video.currentTime / video.duration) * 100);
    fill.style.width = `${pct}%`;
  });

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

function initFeed() {
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

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initFeed);
} else {
  initFeed();
}
