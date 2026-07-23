# Black Days — Verification Policy

Every media item carries exactly one verification status. The archive's credibility depends on never implying certainty that does not exist. **When in doubt, use the lower status.**

**Not currently rendered anywhere in the UI.** This policy governs how `verificationStatus` is assigned in `src/data/videos.json`; the field is required and validated by `src/lib/schema.ts`. Display is a separate concern — see "Display" below.

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
5. Sample/placeholder entries are exempt. The `sample` field is supported by the schema and by the placeholder-banner code path on `/video/[id]`, but no entry currently sets it — the exemption applies whenever one is reintroduced.

## Display

`src/components/VerificationBadge.astro` is fully implemented (five colors, WCAG-contrast-checked) but is not imported anywhere in `src/` — it renders on no page. This is deliberate: `verificationStatus` is still recorded and validated on every entry, but nothing in the current UI surfaces a per-item badge. `/about` instead states plainly, once, that nothing in the archive has been independently verified. The component is kept on disk (not deleted) so that reinstating a badge, or building different verification UI, is a display change rather than a re-derivation of every entry's status. See `docs/design-spec.md` §5 and §10 for the corresponding colors/design-side record.
