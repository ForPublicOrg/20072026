#!/usr/bin/env node
// Metadata enrichment for the blackdays archive: derives the fields that are
// safe to fill automatically, and *proposes* (never silently applies) the
// fields that need a human's editorial judgment. See docs/content-pipeline.md
// ("Editorial rules") and docs/verification-policy.md for why some fields
// cannot be guessed.
//
// Two phases, deliberately kept as separate subcommands rather than one
// merged step — that separation is the whole safety property:
//
//   1. `node scripts/enrich.mjs propose [--out <path>]`
//        Read-only on src/data/videos.json. Computes a proposal per entry
//        per field and writes a review file (JSON). Never writes videos.json.
//
//   2. `node scripts/enrich.mjs apply --review <path>`
//        Reads the review file produced above. For each field whose
//        proposal has "status": "accepted", writes that value into the
//        matching entry in videos.json. Anything still "proposed" or
//        "blocked" is left untouched. This command does not derive or
//        re-derive anything itself — it is a dumb, literal writer that
//        trusts the review file completely. A human is expected to have
//        edited that file (accepting, rejecting, or replacing values)
//        before this runs.
//
// `date` is marked "accepted" automatically by `propose` when it can be
// derived at all — the task calls it "SAFE, fully automatic... no human
// review needed" since it's just a reformat of source.publishedAt, which
// collect.mjs already captured from yt-dlp. `description`, `tags`, and
// `location` always come out as "proposed"/"blocked" and require a human to
// flip the status before `apply` will touch them.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const VIDEOS_JSON = path.join(ROOT, "src/data/videos.json");

// Run artifacts (review files) are not archive content — keep them out of
// the repo. Same convention as scripts/collect-batch.mjs's LOG_FILE.
if (!process.env.BLACKDAYS_SCRATCH_DIR) {
  console.error(
    "BLACKDAYS_SCRATCH_DIR is not set. Point it at a directory outside the repo " +
      "for review-file output (e.g. export BLACKDAYS_SCRATCH_DIR=/tmp/blackdays-scratch).",
  );
  process.exit(1);
}
const SCRATCH_DIR = process.env.BLACKDAYS_SCRATCH_DIR;
const DEFAULT_REVIEW_FILE = path.join(SCRATCH_DIR, "enrich-review.json");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// yt-dlp's own fallback title for an Instagram post it couldn't get a
// caption for (or that has none). collect.mjs stores ONLY meta.title into
// the entry's `title` field — it never captures meta.description (the
// actual IG caption text) anywhere. An entry whose title matches this
// pattern therefore carries zero caption signal today. Contrast with
// X/Twitter, where yt-dlp's `title` field already equals the tweet text
// (see video-010..013 in videos.json, whose titles ARE the caption) — for
// those, `title` doubles as a caption proxy with no second fetch needed.
const GENERIC_IG_TITLE_RE = /^Video by\s+\S+$/i;

// Keyword -> candidate tag, built from words that actually occur in this
// archive's existing tag vocabulary (see collectTagVocabulary below).
// Matching is deliberately crude substring matching over lowercased text.
// It only ever produces a *suggestion* — see deriveTags.
const TAG_KEYWORD_MAP = {
  march: ["march", "walk", "procession", "yatra"],
  crowd: ["crowd", "gathering", "people", "janta"],
  police: ["police", "cop", "constable", "officer", "khaki"],
  "crowd-control": ["dispersal", "disperse", "lathi-charge", "lathicharge", "lathicharge"],
  barricade: ["barricade", "barrier"],
  detention: ["detain", "arrest", "custody", "picked up"],
  lathi: ["lathi", "cane", "baton"],
  flags: ["flag", "tricolour", "tricolor"],
  "hunger-strike": ["hunger strike", "hunger-strike", "fast unto death"],
  "sit-in": ["sit-in", "sit in", "dharna", "encampment"],
  rally: ["rally", "protest", "demonstration", "andolan"],
  stage: ["stage", "podium", "banner", "mic", "microphone"],
  force: ["force", "beaten", "assault", "violence", "brutal"],
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function readVideos() {
  if (!existsSync(VIDEOS_JSON)) return [];
  const raw = readFileSync(VIDEOS_JSON, "utf8").trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function isTodoString(value) {
  return value === "TODO";
}

function isTodoTagsArray(value) {
  return Array.isArray(value) && value.length === 1 && value[0] === "TODO";
}

// Vocabulary = every non-"TODO" tag already used anywhere in videos.json.
// Candidates offered for new entries are restricted to this set so we never
// invent a brand-new taxonomy term as a side effect of enrichment.
function collectTagVocabulary(entries) {
  const vocab = new Set();
  for (const entry of entries) {
    for (const tag of entry.tags ?? []) {
      if (tag !== "TODO") vocab.add(tag);
    }
  }
  return vocab;
}

// ---------------------------------------------------------------------------
// Per-field derivation. Each returns { status, value, confidence, rationale }
// (plus extra fields where useful). status is one of:
//   "accepted"  — safe enough that propose sets it directly; apply will write it.
//   "proposed"  — a candidate exists; a human must flip status to "accepted".
//   "blocked"   — no safe derivation possible; field is left as-is.
//   "skipped"   — field wasn't "TODO" to begin with; nothing to do.
// ---------------------------------------------------------------------------

function deriveDate(entry) {
  if (!isTodoString(entry.date)) {
    return { status: "skipped", value: entry.date, confidence: null, rationale: "date is not TODO" };
  }
  const publishedAt = entry.source?.publishedAt;
  if (typeof publishedAt === "string" && DATE_RE.test(publishedAt)) {
    return {
      status: "accepted",
      value: publishedAt,
      confidence: "high",
      rationale:
        "Copied from source.publishedAt, which collect.mjs already derived from yt-dlp's upload_date at collection time. This is the post's publish date, not necessarily the date of the event depicted — for the 5 existing real entries, publishedAt and the human-assigned event date always matched (posts here go up same-day or within a day), but that is a pattern, not a guarantee. Flagging for anyone auditing this default.",
    };
  }
  return {
    status: "blocked",
    value: null,
    confidence: null,
    rationale: `source.publishedAt is "${publishedAt}" — not a YYYY-MM-DD date, so nothing to derive from (yt-dlp had no upload_date for this URL).`,
  };
}

function deriveDescription(entry) {
  if (!isTodoString(entry.description)) {
    return {
      status: "skipped",
      value: entry.description,
      confidence: null,
      rationale: "description is not TODO",
    };
  }

  const title = entry.title ?? "";
  const isGenericIgTitle =
    entry.source?.platform === "Instagram" && GENERIC_IG_TITLE_RE.test(title.trim());

  if (isGenericIgTitle) {
    return {
      status: "blocked",
      value: null,
      confidence: null,
      needsSecondPass: true,
      rationale:
        "title is yt-dlp's generic Instagram fallback (\"Video by <handle>\"), which means this post's caption was never captured. collect.mjs only stores meta.title into the entry, and yt-dlp's meta.description (the actual IG caption) is discarded at collection time. Getting the caption requires a SECOND yt-dlp --dump-json pass over this URL. Even once fetched, the caption should NOT be written directly into `description` (see posterCaptionSuggestion field design note) — it is the poster's framing, and this archive's description field is supposed to state only what is visible in the footage.",
    };
  }

  // title text plausibly already carries caption-like content (this is the
  // case for the current X/Twitter entries, where yt-dlp's title field is
  // the tweet text itself). Still never auto-promoted into `description` —
  // only offered as a clearly-attributed suggestion for a human to turn
  // into neutral archive prose or reject outright.
  return {
    status: "proposed",
    value: null,
    posterCaptionSuggestion: title,
    confidence: "low",
    rationale:
      "title text may double as caption content for this platform (observed for X/Twitter entries, where yt-dlp's title field equals the post text). This is the POSTER'S framing, not neutral archive prose, and must not be copied into `description` verbatim — rewrite to state only what is visible (see docs/content-pipeline.md 'Editorial rules': 'crowd moves down MG Road' not a conclusion), or reject if the caption is uninformative/promotional.",
  };
}

function deriveTags(entry, vocabulary) {
  if (!isTodoTagsArray(entry.tags)) {
    return { status: "skipped", value: entry.tags, confidence: null, rationale: "tags is not [\"TODO\"]" };
  }

  const haystack = `${entry.title ?? ""}`.toLowerCase();
  const candidates = [];
  for (const [tag, keywords] of Object.entries(TAG_KEYWORD_MAP)) {
    if (!vocabulary.has(tag)) continue; // stay within existing vocabulary
    if (keywords.some((kw) => haystack.includes(kw))) {
      candidates.push(tag);
    }
  }

  if (candidates.length === 0) {
    return {
      status: "blocked",
      value: null,
      confidence: null,
      rationale:
        "No keyword match against the existing tag vocabulary in the title text. Most likely cause: title is a generic platform fallback (e.g. \"Video by <handle>\") with no caption text to scan — same root cause as the description block. A second metadata pass that recovers the caption would give this far more to work with.",
    };
  }

  return {
    status: "proposed",
    value: candidates,
    confidence: "low",
    rationale:
      `Keyword-matched against title text only (caption not available for this entry — see description proposal). ` +
      `Candidates are restricted to tags already used elsewhere in videos.json: ${[...vocabulary].sort().join(", ")}. ` +
      "Always for human confirmation; never auto-applied.",
  };
}

function deriveLocation(entry) {
  if (!isTodoString(entry.location)) {
    return { status: "skipped", value: entry.location, confidence: null, rationale: "location is not TODO" };
  }
  return {
    status: "blocked",
    value: null,
    confidence: null,
    rationale:
      "No reliable signal exists anywhere collect.mjs captures (no GPS/EXIF from yt-dlp for these platforms, no landmark recognition here). Per docs/verification-policy.md, location claims need independent corroboration before they're asserted at all, let alone auto-filled. Left for human fill; this script will never guess it.",
  };
}

// ---------------------------------------------------------------------------
// propose
// ---------------------------------------------------------------------------

function buildProposal(entry, vocabulary) {
  return {
    id: entry.id,
    title: entry.title,
    sourcePlatform: entry.source?.platform ?? null,
    sourceUrl: entry.source?.url ?? null,
    current: {
      description: entry.description,
      date: entry.date,
      location: entry.location,
      tags: entry.tags,
    },
    proposed: {
      date: deriveDate(entry),
      description: deriveDescription(entry),
      tags: deriveTags(entry, vocabulary),
      location: deriveLocation(entry),
    },
  };
}

function cmdPropose(args) {
  const outIdx = args.indexOf("--out");
  const outPath = outIdx >= 0 && args[outIdx + 1] ? path.resolve(args[outIdx + 1]) : DEFAULT_REVIEW_FILE;

  if (outPath.startsWith(ROOT)) {
    console.error(
      `Refusing to write the review file inside the repo (${path.relative(ROOT, outPath)}). ` +
        "Review files are run artifacts, not archive content — pass --out with a path outside the repo " +
        "(e.g. under BLACKDAYS_SCRATCH_DIR).",
    );
    process.exit(1);
  }

  const entries = readVideos(); // read-only — videos.json is never written by this command
  const vocabulary = collectTagVocabulary(entries);

  const proposals = entries.map((entry) => buildProposal(entry, vocabulary));

  const needingWork = proposals.filter((p) =>
    Object.values(p.proposed).some((f) => f.status !== "skipped"),
  );

  const payload = {
    generatedAt: new Date().toISOString(),
    videosJsonEntryCount: entries.length,
    tagVocabulary: [...vocabulary].sort(),
    note:
      "This file is a proposal, not a write. Nothing here has touched src/data/videos.json. " +
      "Edit the `proposed.<field>.status` values below to \"accepted\" (adding/fixing `value` as needed) " +
      "for anything you want written, then run: node scripts/enrich.mjs apply --review <this file>. " +
      "Fields left \"proposed\" or \"blocked\" are skipped by apply.",
    entries: proposals,
  };

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n");

  // ---- console summary -----------------------------------------------------
  const total = entries.length;
  const withTodo = needingWork.length;
  const dateAccepted = proposals.filter((p) => p.proposed.date.status === "accepted").length;
  const dateBlocked = proposals.filter((p) => p.proposed.date.status === "blocked").length;
  const descProposed = proposals.filter((p) => p.proposed.description.status === "proposed").length;
  const descBlocked = proposals.filter((p) => p.proposed.description.status === "blocked").length;
  const tagsProposed = proposals.filter((p) => p.proposed.tags.status === "proposed").length;
  const tagsBlocked = proposals.filter((p) => p.proposed.tags.status === "blocked").length;
  const locBlocked = proposals.filter((p) => p.proposed.location.status === "blocked").length;
  const needsSecondPass = proposals.filter((p) => p.proposed.description.needsSecondPass).length;

  console.log(`Read ${total} entr${total === 1 ? "y" : "ies"} from ${path.relative(ROOT, VIDEOS_JSON)} (read-only).`);
  console.log(`${withTodo} entr${withTodo === 1 ? "y" : "ies"} have at least one TODO field.`);
  console.log("");
  console.log(`date:        ${dateAccepted} auto-accepted, ${dateBlocked} blocked (no publishedAt)`);
  console.log(`description: ${descProposed} proposed (needs human edit), ${descBlocked} blocked`);
  console.log(`tags:        ${tagsProposed} proposed (needs human confirm), ${tagsBlocked} blocked`);
  console.log(`location:    ${locBlocked} blocked (never guessed)`);
  console.log("");
  if (needsSecondPass > 0) {
    console.log(
      `${needsSecondPass} entr${needsSecondPass === 1 ? "y" : "ies"} blocked on description need a SECOND yt-dlp ` +
        "metadata pass to recover the Instagram caption (not run by this command). Pace that pass politely " +
        "(single-digit requests/minute) — same IP/quota as the running collector.",
    );
  }
  console.log(`\nReview file written to ${outPath}`);
}

// ---------------------------------------------------------------------------
// apply — NOT run as part of this task. Included so the propose/apply
// contract is real and testable later, once a human has edited a review
// file. Deliberately dumb: it never re-derives anything, it only copies
// values whose status is "accepted".
// ---------------------------------------------------------------------------

function cmdApply(args) {
  const reviewIdx = args.indexOf("--review");
  const reviewPath = reviewIdx >= 0 && args[reviewIdx + 1] ? path.resolve(args[reviewIdx + 1]) : null;
  if (!reviewPath || !existsSync(reviewPath)) {
    console.error("Usage: node scripts/enrich.mjs apply --review <path-to-review-file>");
    process.exit(1);
  }

  const review = JSON.parse(readFileSync(reviewPath, "utf8"));
  const videos = readVideos();
  const byId = new Map(videos.map((v) => [v.id, v]));

  let changedEntries = 0;
  let changedFields = 0;
  const skippedNotAccepted = [];

  for (const proposalEntry of review.entries ?? []) {
    const target = byId.get(proposalEntry.id);
    if (!target) {
      console.warn(`Skipping ${proposalEntry.id}: no longer present in videos.json.`);
      continue;
    }
    let touchedThisEntry = false;
    for (const field of ["date", "description", "location"]) {
      const proposal = proposalEntry.proposed?.[field];
      if (!proposal) continue;
      if (proposal.status === "accepted") {
        if (typeof proposal.value !== "string" || proposal.value.length === 0) {
          console.warn(`Skipping ${proposalEntry.id}.${field}: status is "accepted" but value is empty/invalid.`);
          continue;
        }
        target[field] = proposal.value;
        touchedThisEntry = true;
        changedFields++;
      } else {
        skippedNotAccepted.push(`${proposalEntry.id}.${field} (${proposal.status})`);
      }
    }
    const tagsProposal = proposalEntry.proposed?.tags;
    if (tagsProposal) {
      if (tagsProposal.status === "accepted") {
        if (!Array.isArray(tagsProposal.value) || tagsProposal.value.length === 0) {
          console.warn(`Skipping ${proposalEntry.id}.tags: status is "accepted" but value is empty/invalid.`);
        } else {
          target.tags = tagsProposal.value;
          touchedThisEntry = true;
          changedFields++;
        }
      } else {
        skippedNotAccepted.push(`${proposalEntry.id}.tags (${tagsProposal.status})`);
      }
    }
    if (touchedThisEntry) changedEntries++;
  }

  writeFileSync(VIDEOS_JSON, JSON.stringify(videos, null, 2) + "\n");
  console.log(`Applied ${changedFields} field(s) across ${changedEntries} entr(y/ies) into ${VIDEOS_JSON}.`);
  if (skippedNotAccepted.length > 0) {
    console.log(`Left untouched (status not "accepted"): ${skippedNotAccepted.length} field(s).`);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const [, , subcommand, ...rest] = process.argv;
  if (subcommand === "propose") {
    cmdPropose(rest);
  } else if (subcommand === "apply") {
    cmdApply(rest);
  } else {
    console.error(
      "Usage:\n" +
        "  node scripts/enrich.mjs propose [--out <path>]   # read-only; writes a review file\n" +
        "  node scripts/enrich.mjs apply --review <path>    # writes videos.json from an edited review file\n",
    );
    process.exit(1);
  }
}

main();
