# Black Days — Verification Policy

Every media item carries exactly one verification status. The archive's credibility depends on never implying certainty that does not exist. **When in doubt, use the lower status.**

**Not currently rendered anywhere in the UI (as of 2026-07-21).** This policy still governs how `verificationStatus` is assigned in `src/data/videos.json`, and the field is still required and validated by `src/lib/schema.ts` — nothing below is obsolete as *data* policy. What changed is display: the feed, the `/video/[id]` page, and the about page no longer show a badge for it at all. `src/components/VerificationBadge.astro` still exists on disk with its full five-color set but is no longer imported by anything. See "Display rules" below for the history of how the badge went from "always shown" to "shown on some pages" to "shown nowhere," and `docs/design-spec.md` §9 for the corresponding design-side record.

## Statuses

### `verified`
All of the following hold:
- Location confirmed by at least two independent means (visible landmarks matched to street imagery, corroborating footage from another angle, or credible on-the-ground reporting naming the place).
- Date/time confirmed by at least two independent means (original upload timestamp consistent with events, shadows/lighting, corroborating reports).
- Original source identified (first known upload found; not a re-upload mistaken for the origin).
- No signs of manipulation (no splices, no mismatched audio, no AI-generation artifacts).

### `likely-verified`
Location **and** date each supported by at least one strong indicator, original source plausibly identified, no manipulation signs — but full two-source corroboration is incomplete.

### `partially-verified`
Some claims check out and are listed explicitly (e.g., "location verified; date unconfirmed"). The displayed description must say which parts are verified.

### `unverified`
Default for everything entering the archive. Nothing beyond the existence of the public post has been checked. This label is honest, not pejorative.

### `context-unclear`
The footage is real but its framing is in question: it may be from a different event, date, or place than claimed, or circulating captions conflict. Use this instead of `unverified` when there is *active reason to doubt the claimed context*.

## Process rules

1. Every item enters as `unverified` (the pipeline enforces this).
2. Status upgrades are manual edits to `videos.json`, made only after the checks above; note the evidence in the entry's `description` when practical.
3. Downgrades are immediate: if new information casts doubt, drop the status first, investigate after.
4. Never delete an entry to hide an error — correct it. If material must be removed (takedown, privacy, safety), remove media files but keep the metadata entry with a note, so the record of the record survives.
5. Sample/placeholder entries are exempt. The `sample` field is still supported by the schema (`src/lib/schema.ts`) and by the placeholder-banner code path on `/video/[id]`, but as of 2026-07-21 the eight sample entries and their media were deleted from `videos.json` now that real footage exists — no entry currently has `"sample": true`. If sample entries are ever reintroduced (e.g. to demo the pipeline again), this exemption still applies.

## Display rules

**As of 2026-07-21, the badge renders nowhere in the UI.** This is the end state of a same-day sequence, kept here rather than overwritten so the reasoning survives:

1. **Originally:** the badge was always visible on the item's own `/video/[id]` page — never hidden, never defaulted to a higher status by UI fallback — and also rendered on every feed card.
2. **Feed exception (added 2026-07-21, midday):** on `/feed` cards only, the badge was suppressed when the status was `unverified`. `unverified` is the default every entry starts with; at the time this was written 4 of 5 real entries carried it, so a label present on nearly every card conveyed no information and made the feed read as defensive. The other four statuses still rendered on feed cards. The `/video/[id]` page was untouched by this change — it kept showing the badge unconditionally.
3. **Total removal (2026-07-21, evening, commit `b8f0fdc`), current state:** the badge was removed from the UI entirely — not just the feed's `unverified` case, but every status on every surface: the feed, `/video/[id]`, and the about page's former "How verification works" section (which was deleted; see the about-page rewrite in the same commit). `verificationStatus` still exists on every entry and is still validated at build time; this change removed the *display*, not the *record*. `VerificationBadge.astro` was left in place on disk (unimported) rather than deleted, in case badge display is reinstated later.

Why the record is kept even though nothing renders it: it is cheap to maintain, it documents editorial judgment made about specific entries, and it means reinstating a badge (or building some other verification UI) later is a display change, not a re-litigation of every entry's status.

- Badge colors, when they did render, were muted and informational, not alarmist: e.g. verified = muted green, likely = teal, partially = amber, unverified = neutral gray, context-unclear = orange. The specific values (re-derived for the true-black theme) are preserved in `docs/design-spec.md` §9 and in `VerificationBadge.astro` itself, for whoever reinstates display.
- The `/about` page no longer explains the five statuses or links to this policy from site copy — see `docs/design-spec.md` §7 for what replaced that section. This document remains the source of truth for how `verificationStatus` is assigned; it is just no longer surfaced to readers directly from the site.
