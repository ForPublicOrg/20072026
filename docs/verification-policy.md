# Black Days — Verification Policy

Every media item displays exactly one verification status. The archive's credibility depends on never implying certainty that does not exist. **When in doubt, use the lower status.**

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
5. Sample/placeholder entries are exempt (they carry `"sample": true` and are labeled SAMPLE in the UI).

## Display rules

- The badge is always visible on the item's own `/video/[id]` page — never hidden, never defaulted to a higher status by UI fallback.
- **Feed exception (added 2026-07-21):** on `/feed` cards only, the badge is suppressed when the status is `unverified`. `unverified` is the default every entry starts with; at the time this was written 4 of 5 real entries carried it, so a label present on nearly every card conveyed no information and made the feed read as defensive. The other four statuses (`verified`, `likely-verified`, `partially-verified`, `context-unclear`) still render on feed cards — they either add credibility or flag an actively disputed framing, which is information. The badge is also suppressed on `sample: true` cards so it never competes with the SAMPLE banner. This is a feed-only display choice: the underlying status is unchanged, every entry still has one, and the detail page always shows it, unabridged.
- Badge colors are muted and informational, not alarmist: e.g. verified = muted green, likely = teal, partially = amber, unverified = neutral gray, context-unclear = orange.
- The `/about` page links to this policy in plain language and still explains all five statuses, including `unverified`.
