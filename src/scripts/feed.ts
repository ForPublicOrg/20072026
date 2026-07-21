// Feed autoplay behavior for the homepage reels-style feed.
// See docs/implementation-guide.md §5 / docs/design-spec.md §8.

const ACTIVATE_THRESHOLD = 0.6;

function updateMuteIndicator(card: Element, muted: boolean) {
  const indicator = card.querySelector<HTMLElement>(".mute-indicator");
  if (!indicator) return;
  indicator.dataset.muted = String(muted);
  indicator.setAttribute("aria-label", muted ? "Unmute video" : "Mute video");
  indicator.textContent = muted ? "\u{1F507}" : "\u{1F50A}";
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

function setupCardInteractions(card: HTMLElement) {
  const video = card.querySelector<HTMLVideoElement>("video");
  if (!video) return;

  updateMuteIndicator(card, video.muted);

  const toggleMute = (event: Event) => {
    event.preventDefault();
    video.muted = !video.muted;
    updateMuteIndicator(card, video.muted);
  };

  video.addEventListener("click", toggleMute);
  card.querySelector(".mute-indicator")?.addEventListener("click", toggleMute);

  card.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      if (event.key === " ") event.preventDefault();
      if (video.paused) {
        video.play().catch(() => {});
      } else {
        video.pause();
      }
    }
  });
}

function setupReducedMotion(cards: HTMLElement[]) {
  cards.forEach((card) => {
    const video = card.querySelector<HTMLVideoElement>("video");
    if (!video) return;
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

  cards.forEach(setupCardInteractions);

  const prefersReducedMotion = matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

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
