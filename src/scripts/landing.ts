// Staged-reveal storyline for the landing page (`/`). See
// docs/design-spec.md §7.
//
// Progressive enhancement contract: `.reveal` sections are visible by
// default in CSS (src/pages/index.astro). This script's only job is to
// OPT IN to the hide-then-fade-in treatment by adding `.js-enhanced`, and
// only when both of these hold:
//   - JavaScript actually ran (obviously — this is that script)
//   - the user has no `prefers-reduced-motion: reduce` preference
// If either doesn't hold, sections are left exactly as CSS already
// rendered them: fully visible. Nothing can end up permanently hidden.

function initLandingReveals() {
  const sections = Array.from(
    document.querySelectorAll<HTMLElement>(".reveal"),
  );
  if (sections.length === 0) return;

  const prefersReducedMotion = matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  if (prefersReducedMotion || !("IntersectionObserver" in window)) {
    // Reduced motion, or no observer support: stay on the default visible
    // CSS state, don't opt in to the fade treatment at all.
    return;
  }

  sections.forEach((section) => section.classList.add("js-enhanced"));

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.2, rootMargin: "0px 0px -10% 0px" },
  );

  sections.forEach((section) => observer.observe(section));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initLandingReveals);
} else {
  initLandingReveals();
}
