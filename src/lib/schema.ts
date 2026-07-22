// Data model + build-time validation for the 20.07.2026 archive's content.
// Pages must get video/timeline data ONLY through loadVideos() / loadTimeline().
// A malformed data file throws here, which fails `astro build` — the whole
// point being that bad data never reaches the live site.

import videosData from "../data/videos.json";
import timelineData from "../data/timeline.json";

export type VerificationStatus =
  | "verified"
  | "likely-verified"
  | "partially-verified"
  | "unverified"
  | "context-unclear";

const VERIFICATION_STATUSES: readonly VerificationStatus[] = [
  "verified",
  "likely-verified",
  "partially-verified",
  "unverified",
  "context-unclear",
];

export interface VideoSource {
  platform: string;
  url: string; // original public URL — always preserved
  uploader: string;
  publishedAt: string;
}

export interface VideoMedia {
  video: string; // path relative to MEDIA_BASE
  thumbnail: string; // path relative to MEDIA_BASE
  duration: number; // seconds, from ffprobe
  width: number;
  height: number;
}

export interface VideoEntry {
  id: string; // stable slug, never reused, e.g. "video-001"
  title: string;
  description: string; // factual, no editorializing
  date: string; // date of the event depicted (ISO)
  location?: string; // omitted when not yet verified — never a guessed placeholder
  tags: string[]; // defaults to [] when not yet tagged
  verificationStatus: VerificationStatus;
  sample?: boolean; // present + true ONLY for placeholder entries
  source: VideoSource;
  media: VideoMedia;
  archivedAt: string;
}

/**
 * A citation for a timeline event. The timeline makes factual claims about
 * events this archive did not witness, so each entry carries the reporting it
 * is drawn from and links out to it — the reader checks the source, rather
 * than taking this site's word for it.
 */
export interface TimelineSource {
  title: string;
  url: string;
}

/**
 * What an official actually said, tied to a timeline event. Same contract as
 * everything else in the archive: the quote is the speaker's words AS QUOTED
 * by the cited source (never reconstructed from memory or paraphrase), and
 * the source link lets the reader check it. An event with no statements
 * simply omits the field — silence is recorded by absence, not invented copy.
 */
export type StatementKind =
  | "tweet"
  | "address"
  | "press"
  | "parliament"
  | "court"
  | "interview";

const STATEMENT_KINDS: readonly StatementKind[] = [
  "tweet",
  "address",
  "press",
  "parliament",
  "court",
  "interview",
];

export interface TimelineStatement {
  speaker: string; // e.g. "Narendra Modi"
  role: string; // e.g. "Prime Minister"
  kind: StatementKind;
  date: string; // date-only ISO string of when the statement was made
  quote: string; // verbatim excerpt as quoted by the cited source
  context?: string; // one factual line on where/how it was said
  source: TimelineSource;
}

/**
 * A photograph attached to a timeline event. Same rules as archived video:
 * a real capture by a real person, credited, with a link to where the
 * original lives (Commons file page, original post). Only freely licensed
 * images or participant-posted photos consistent with the archive's
 * attribution + takedown model are committed - agency photography is never
 * copied into this repo, only linked from an event's sources.
 */
export interface TimelineImage {
  src: string; // site-relative path under /timeline/, committed to public/
  alt: string;
  caption: string; // factual, no editorializing
  credit: string; // photographer/account + license, e.g. "Photo: X, CC BY-SA 4.0"
  sourceUrl: string; // where the original lives - the reader can check it
  width: number; // intrinsic px, required so the layout never shifts
  height: number;
}

export interface TimelineEvent {
  time: string; // date-only ISO string; we have never had a clock time for these
  title: string;
  description: string;
  relatedVideoIds: string[];
  sources?: TimelineSource[];
  statements?: TimelineStatement[];
  image?: TimelineImage;
}

const VIDEO_ID_RE = /^video-\d{3}$/;

function fail(entryLabel: string, message: string): never {
  throw new Error(`Invalid entry ${entryLabel}: ${message}`);
}

function requireObject(
  value: unknown,
  entryLabel: string,
  field: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(entryLabel, `field "${field}" must be an object (got ${typeof value})`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, entryLabel: string, field: string): string {
  if (typeof value !== "string") {
    fail(entryLabel, `field "${field}" must be a string (got ${typeof value})`);
  }
  return value as string;
}

function requireNumber(value: unknown, entryLabel: string, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(entryLabel, `field "${field}" must be a number (got ${typeof value})`);
  }
  return value as number;
}

function requireStringArray(value: unknown, entryLabel: string, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    fail(entryLabel, `field "${field}" must be an array of strings`);
  }
  return value as string[];
}

// location: genuinely optional. Unlike the other string fields, this
// archive will not fabricate a location, so an entry that hasn't been
// geo-verified yet has no value here at all — not an empty string, not a
// placeholder. Presence is still type-checked when the field IS given.
function optionalString(value: unknown, entryLabel: string, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    fail(entryLabel, `field "${field}" must be a string when present (got ${typeof value})`);
  }
  return value;
}

// tags: genuinely optional, defaulting to an empty array rather than
// undefined so callers can always .map()/.filter() without a null check.
function optionalStringArray(value: unknown, entryLabel: string, field: string): string[] {
  if (value === undefined) return [];
  return requireStringArray(value, entryLabel, field);
}

// Recursively walk every string field in an already-built entry and reject
// literal "TODO" placeholders, unless the entry is explicitly marked as a
// sample/placeholder entry.
function checkNoTodoStrings(
  value: unknown,
  entryLabel: string,
  isSample: boolean,
  path = "",
): void {
  if (isSample) return;
  if (typeof value === "string") {
    if (value === "TODO") {
      fail(
        entryLabel,
        `field "${path || "(root)"}" is "TODO" but entry is not marked sample: true`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => checkNoTodoStrings(item, entryLabel, isSample, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      checkNoTodoStrings(val, entryLabel, isSample, path ? `${path}.${key}` : key);
    }
  }
}

function validateVideoEntry(raw: unknown, index: number): VideoEntry {
  const indexLabel = `videos.json[${index}]`;
  const obj = requireObject(raw, indexLabel, "(root)");

  const id = requireString(obj.id, indexLabel, "id");
  const label = `${id} (${indexLabel})`;

  if (!VIDEO_ID_RE.test(id)) {
    fail(label, `field "id" ("${id}") must match /^video-\\d{3}$/`);
  }

  const title = requireString(obj.title, label, "title");
  const description = requireString(obj.description, label, "description");
  const date = requireString(obj.date, label, "date");
  const location = optionalString(obj.location, label, "location");
  const tags = optionalStringArray(obj.tags, label, "tags");

  const verificationStatus = requireString(obj.verificationStatus, label, "verificationStatus");
  if (!VERIFICATION_STATUSES.includes(verificationStatus as VerificationStatus)) {
    fail(
      label,
      `field "verificationStatus" ("${verificationStatus}") must be one of ${VERIFICATION_STATUSES.join(", ")}`,
    );
  }

  let sample: boolean | undefined;
  if (obj.sample !== undefined) {
    if (typeof obj.sample !== "boolean") {
      fail(label, `field "sample" must be a boolean when present (got ${typeof obj.sample})`);
    }
    sample = obj.sample;
  }

  const sourceObj = requireObject(obj.source, label, "source");
  const source: VideoSource = {
    platform: requireString(sourceObj.platform, label, "source.platform"),
    url: requireString(sourceObj.url, label, "source.url"),
    uploader: requireString(sourceObj.uploader, label, "source.uploader"),
    publishedAt: requireString(sourceObj.publishedAt, label, "source.publishedAt"),
  };

  const mediaObj = requireObject(obj.media, label, "media");
  const media: VideoMedia = {
    video: requireString(mediaObj.video, label, "media.video"),
    thumbnail: requireString(mediaObj.thumbnail, label, "media.thumbnail"),
    duration: requireNumber(mediaObj.duration, label, "media.duration"),
    width: requireNumber(mediaObj.width, label, "media.width"),
    height: requireNumber(mediaObj.height, label, "media.height"),
  };

  const archivedAt = requireString(obj.archivedAt, label, "archivedAt");

  const entry: VideoEntry = {
    id,
    title,
    description,
    date,
    ...(location !== undefined ? { location } : {}),
    tags,
    verificationStatus: verificationStatus as VerificationStatus,
    ...(sample !== undefined ? { sample } : {}),
    source,
    media,
    archivedAt,
  };

  checkNoTodoStrings(entry, label, sample === true);

  return entry;
}

function validateTimelineEvent(
  raw: unknown,
  index: number,
  validVideoIds: ReadonlySet<string>,
): TimelineEvent {
  const indexLabel = `timeline.json[${index}]`;
  const obj = requireObject(raw, indexLabel, "(root)");

  const time = requireString(obj.time, indexLabel, "time");
  const label = `${indexLabel} (time: ${time})`;

  const title = requireString(obj.title, label, "title");
  const description = requireString(obj.description, label, "description");
  const relatedVideoIds = requireStringArray(obj.relatedVideoIds, label, "relatedVideoIds");

  for (const videoId of relatedVideoIds) {
    if (!validVideoIds.has(videoId)) {
      fail(
        label,
        `field "relatedVideoIds" references unknown video id "${videoId}"`,
      );
    }
  }

  // Citations are optional, but a malformed one must fail the build rather
  // than silently vanish from the page — an event whose sourcing quietly
  // disappeared is worse than one that never claimed any.
  let sources: TimelineSource[] | undefined;
  if (obj.sources !== undefined) {
    if (!Array.isArray(obj.sources)) {
      fail(label, `field "sources" must be an array`);
    }
    sources = obj.sources.map((raw, sourceIndex) => {
      const sourceLabel = `${label} sources[${sourceIndex}]`;
      const source = requireObject(raw, sourceLabel, "(root)");
      const sourceTitle = requireString(source.title, sourceLabel, "title");
      const url = requireString(source.url, sourceLabel, "url");
      if (!/^https?:\/\//.test(url)) {
        fail(sourceLabel, `field "url" must be an absolute http(s) URL (got "${url}")`);
      }
      return { title: sourceTitle, url };
    });
  }

  // Statements are held to the same bar as citations: optional, but a
  // malformed one fails the build. A quote attributed to a real person with
  // no checkable source is exactly what this archive exists to not do.
  let statements: TimelineStatement[] | undefined;
  if (obj.statements !== undefined) {
    if (!Array.isArray(obj.statements)) {
      fail(label, `field "statements" must be an array`);
    }
    statements = obj.statements.map((rawStatement, statementIndex) => {
      const statementLabel = `${label} statements[${statementIndex}]`;
      const statement = requireObject(rawStatement, statementLabel, "(root)");

      const kind = requireString(statement.kind, statementLabel, "kind");
      if (!STATEMENT_KINDS.includes(kind as StatementKind)) {
        fail(
          statementLabel,
          `field "kind" ("${kind}") must be one of ${STATEMENT_KINDS.join(", ")}`,
        );
      }

      const sourceObj = requireObject(statement.source, statementLabel, "source");
      const sourceUrl = requireString(sourceObj.url, statementLabel, "source.url");
      if (!/^https?:\/\//.test(sourceUrl)) {
        fail(statementLabel, `field "source.url" must be an absolute http(s) URL (got "${sourceUrl}")`);
      }

      const context = optionalString(statement.context, statementLabel, "context");

      return {
        speaker: requireString(statement.speaker, statementLabel, "speaker"),
        role: requireString(statement.role, statementLabel, "role"),
        kind: kind as StatementKind,
        date: requireString(statement.date, statementLabel, "date"),
        quote: requireString(statement.quote, statementLabel, "quote"),
        ...(context !== undefined ? { context } : {}),
        source: {
          title: requireString(sourceObj.title, statementLabel, "source.title"),
          url: sourceUrl,
        },
      };
    });
  }

  // Event photo: optional, but held to the citation bar - a credited image
  // with no checkable source page, or a file path outside the committed
  // /timeline/ tree, fails the build.
  let image: TimelineImage | undefined;
  if (obj.image !== undefined) {
    const imageObj = requireObject(obj.image, label, "image");
    const src = requireString(imageObj.src, label, "image.src");
    if (!src.startsWith("/timeline/")) {
      fail(label, `field "image.src" must be a committed /timeline/ path (got "${src}")`);
    }
    const imageSourceUrl = requireString(imageObj.sourceUrl, label, "image.sourceUrl");
    if (!/^https?:\/\//.test(imageSourceUrl)) {
      fail(label, `field "image.sourceUrl" must be an absolute http(s) URL (got "${imageSourceUrl}")`);
    }
    image = {
      src,
      alt: requireString(imageObj.alt, label, "image.alt"),
      caption: requireString(imageObj.caption, label, "image.caption"),
      credit: requireString(imageObj.credit, label, "image.credit"),
      sourceUrl: imageSourceUrl,
      width: requireNumber(imageObj.width, label, "image.width"),
      height: requireNumber(imageObj.height, label, "image.height"),
    };
  }

  const entry: TimelineEvent = {
    time,
    title,
    description,
    relatedVideoIds,
    sources,
    ...(statements !== undefined ? { statements } : {}),
    ...(image !== undefined ? { image } : {}),
  };

  checkNoTodoStrings(entry, label, false);

  return entry;
}

let cachedVideos: VideoEntry[] | null = null;

export function loadVideos(): VideoEntry[] {
  if (cachedVideos) return cachedVideos;

  if (!Array.isArray(videosData)) {
    throw new Error("Invalid videos.json: root must be an array");
  }

  const entries = videosData.map((raw, index) => validateVideoEntry(raw, index));

  const seenIds = new Set<string>();
  for (const entry of entries) {
    if (seenIds.has(entry.id)) {
      throw new Error(`Invalid entry ${entry.id}: duplicate id in videos.json`);
    }
    seenIds.add(entry.id);
  }

  cachedVideos = entries;
  return entries;
}

let cachedTimeline: TimelineEvent[] | null = null;

export function loadTimeline(): TimelineEvent[] {
  if (cachedTimeline) return cachedTimeline;

  if (!Array.isArray(timelineData)) {
    throw new Error("Invalid timeline.json: root must be an array");
  }

  const validVideoIds = new Set(loadVideos().map((video) => video.id));
  const entries = timelineData.map((raw, index) =>
    validateTimelineEvent(raw, index, validVideoIds),
  );

  cachedTimeline = entries;
  return entries;
}
