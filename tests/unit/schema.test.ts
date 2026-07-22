import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadTimeline, loadVideos } from "../../src/lib/schema";

// The real committed data files must always pass validation — this is a
// regression test against bad hand-edits or a bad collect.mjs/CSV run
// landing in src/data/*.json, using the static top-level import above so it
// exercises the exact functions astro build calls.
describe("real content (src/data/videos.json, timeline.json)", () => {
  it("loadVideos() does not throw and returns unique, well-formed ids", () => {
    const videos = loadVideos();
    expect(videos.length).toBeGreaterThan(0);
    const ids = videos.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const video of videos) {
      expect(video.id).toMatch(/^video-\d{3}$/);
    }
  });

  it("loadTimeline() does not throw and every relatedVideoIds entry resolves to a real video", () => {
    const validIds = new Set(loadVideos().map((v) => v.id));
    const timeline = loadTimeline();
    expect(timeline.length).toBeGreaterThan(0);
    for (const event of timeline) {
      for (const id of event.relatedVideoIds) {
        expect(validIds.has(id)).toBe(true);
      }
    }
  });
});

// Everything below exercises the validation logic's edge cases directly,
// against fixture data instead of the real archive — loadVideos/loadTimeline
// cache their result in module-level state, so each test mocks the JSON
// imports and re-imports a fresh copy of the module via resetModules().
function minimalVideo(overrides: Record<string, unknown> = {}) {
  return {
    id: "video-001",
    title: "Title",
    description: "Description",
    date: "2026-07-20",
    tags: [],
    verificationStatus: "unverified",
    source: {
      platform: "instagram",
      url: "https://example.com/p/abc",
      uploader: "someone",
      publishedAt: "2026-07-20",
    },
    media: {
      video: "videos/video-001.mp4",
      thumbnail: "thumbnails/video-001.jpg",
      duration: 8,
      width: 720,
      height: 1280,
    },
    archivedAt: "2026-07-20",
    ...overrides,
  };
}

function minimalTimelineEvent(overrides: Record<string, unknown> = {}) {
  return {
    time: "2026-07-20",
    title: "Event",
    description: "Something happened.",
    relatedVideoIds: ["video-001"],
    ...overrides,
  };
}

async function loadWithFixtures(videos: unknown[], timeline: unknown[] = []) {
  vi.resetModules();
  vi.doMock("../../src/data/videos.json", () => ({ default: videos }));
  vi.doMock("../../src/data/timeline.json", () => ({ default: timeline }));
  return import("../../src/lib/schema");
}

describe("loadVideos() validation", () => {
  beforeEach(() => {
    vi.doUnmock("../../src/data/videos.json");
    vi.doUnmock("../../src/data/timeline.json");
  });

  it("accepts a minimal valid entry", async () => {
    const { loadVideos } = await loadWithFixtures([minimalVideo()]);
    expect(loadVideos()).toHaveLength(1);
  });

  it("throws when the root is not an array", async () => {
    vi.resetModules();
    vi.doMock("../../src/data/videos.json", () => ({ default: { not: "an array" } }));
    vi.doMock("../../src/data/timeline.json", () => ({ default: [] }));
    const { loadVideos } = await import("../../src/lib/schema");
    expect(() => loadVideos()).toThrow(/root must be an array/);
  });

  it("throws when a required field is missing", async () => {
    const bad = minimalVideo();
    delete (bad as Record<string, unknown>).title;
    const { loadVideos } = await loadWithFixtures([bad]);
    expect(() => loadVideos()).toThrow(/"title" must be a string/);
  });

  it("throws when id does not match the video-NNN pattern", async () => {
    const { loadVideos } = await loadWithFixtures([minimalVideo({ id: "video-1" })]);
    expect(() => loadVideos()).toThrow(/must match/);
  });

  it("throws on an unrecognized verificationStatus", async () => {
    const { loadVideos } = await loadWithFixtures([
      minimalVideo({ verificationStatus: "definitely-true" }),
    ]);
    expect(() => loadVideos()).toThrow(/verificationStatus/);
  });

  it("throws on duplicate ids", async () => {
    const { loadVideos } = await loadWithFixtures([minimalVideo(), minimalVideo()]);
    expect(() => loadVideos()).toThrow(/duplicate id/);
  });

  it("throws on a literal TODO field when the entry is not marked sample", async () => {
    const { loadVideos } = await loadWithFixtures([minimalVideo({ description: "TODO" })]);
    expect(() => loadVideos()).toThrow(/is "TODO" but entry is not marked sample/);
  });

  it("allows a literal TODO field when the entry is marked sample: true", async () => {
    const { loadVideos } = await loadWithFixtures([
      minimalVideo({ description: "TODO", sample: true }),
    ]);
    expect(loadVideos()).toHaveLength(1);
  });

  it("throws when sample is present but not a boolean", async () => {
    const { loadVideos } = await loadWithFixtures([minimalVideo({ sample: "true" })]);
    expect(() => loadVideos()).toThrow(/"sample" must be a boolean/);
  });

  it("throws when tags is present but not an array of strings", async () => {
    const { loadVideos } = await loadWithFixtures([minimalVideo({ tags: [1, 2] })]);
    expect(() => loadVideos()).toThrow(/"tags" must be an array of strings/);
  });

  it("throws when media.duration is not a number", async () => {
    const bad = minimalVideo();
    (bad as { media: Record<string, unknown> }).media = {
      ...(bad as { media: Record<string, unknown> }).media,
      duration: "8",
    };
    const { loadVideos } = await loadWithFixtures([bad]);
    expect(() => loadVideos()).toThrow(/"media.duration" must be a number/);
  });

  it("allows location to be omitted, and rejects it when present but non-string", async () => {
    const withoutLocation = minimalVideo();
    delete (withoutLocation as Record<string, unknown>).location;
    const ok = await loadWithFixtures([withoutLocation]);
    expect(ok.loadVideos()).toHaveLength(1);

    const bad = await loadWithFixtures([minimalVideo({ location: 42 })]);
    expect(() => bad.loadVideos()).toThrow(/"location" must be a string when present/);
  });
});

describe("loadTimeline() validation", () => {
  beforeEach(() => {
    vi.doUnmock("../../src/data/videos.json");
    vi.doUnmock("../../src/data/timeline.json");
  });

  it("accepts a minimal valid event referencing a real video id", async () => {
    const { loadTimeline } = await loadWithFixtures([minimalVideo()], [minimalTimelineEvent()]);
    expect(loadTimeline()).toHaveLength(1);
  });

  it("throws when relatedVideoIds references an unknown video id", async () => {
    const { loadTimeline } = await loadWithFixtures(
      [minimalVideo()],
      [minimalTimelineEvent({ relatedVideoIds: ["video-999"] })],
    );
    expect(() => loadTimeline()).toThrow(/references unknown video id/);
  });

  it("throws when a source url is not absolute http(s)", async () => {
    const { loadTimeline } = await loadWithFixtures(
      [minimalVideo()],
      [
        minimalTimelineEvent({
          sources: [{ title: "Some outlet", url: "not-a-url" }],
        }),
      ],
    );
    expect(() => loadTimeline()).toThrow(/must be an absolute http\(s\) URL/);
  });

  it("throws on a statement with an invalid kind", async () => {
    const { loadTimeline } = await loadWithFixtures(
      [minimalVideo()],
      [
        minimalTimelineEvent({
          statements: [
            {
              speaker: "Someone",
              role: "Official",
              kind: "not-a-real-kind",
              date: "2026-07-20",
              quote: "Quoted text.",
              source: { title: "Outlet", url: "https://example.com/article" },
            },
          ],
        }),
      ],
    );
    expect(() => loadTimeline()).toThrow(/field "kind"/);
  });

  it("throws when an event image src is outside the committed /timeline/ tree", async () => {
    const { loadTimeline } = await loadWithFixtures(
      [minimalVideo()],
      [
        minimalTimelineEvent({
          image: {
            src: "/media/not-timeline.jpg",
            alt: "alt",
            caption: "caption",
            credit: "credit",
            sourceUrl: "https://example.com/photo",
            width: 100,
            height: 100,
          },
        }),
      ],
    );
    expect(() => loadTimeline()).toThrow(/must be a committed \/timeline\/ path/);
  });

  it("throws when the timeline root is not an array", async () => {
    vi.resetModules();
    vi.doMock("../../src/data/videos.json", () => ({ default: [minimalVideo()] }));
    vi.doMock("../../src/data/timeline.json", () => ({ default: { not: "an array" } }));
    const { loadTimeline } = await import("../../src/lib/schema");
    expect(() => loadTimeline()).toThrow(/root must be an array/);
  });
});
