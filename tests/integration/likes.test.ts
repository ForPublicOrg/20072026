import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

// Integration tests for the /api/likes/* routes in src/worker.ts, running
// against a real (local) Workers runtime with a real D1 binding (see
// vitest.integration.config.ts + tests/integration/apply-migrations.ts).
// These exercise the same-origin guard, client-id validation, rate limiting,
// and — most importantly — that a repeat like from the same client_id is
// idempotent (video_likes' composite primary key means a double-tap never
// double-counts).

const ORIGIN = "https://20072026.com";
const CLIENT_A = "client-aaaaaaaa";
const CLIENT_B = "client-bbbbbbbb";

async function clearTables() {
  await env.TAKEDOWNS.exec("DELETE FROM takedown_requests");
  await env.SUBMISSIONS.exec("DELETE FROM video_submissions");
  await env.LIKES.exec("DELETE FROM video_likes");
  // GET /api/likes/batch is edge-cached (Cache API); without clearing this
  // between tests, a response cached by an earlier test (e.g. the empty
  // `{}` case) would be served to a later test hitting the same URL.
  await caches.default.delete(`${ORIGIN}/api/likes/batch`);
}

beforeEach(async () => {
  await clearTables();
});

describe("POST /api/likes/:id", () => {
  it("rejects cross-origin requests", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/likes/video-001`, {
      method: "POST",
      headers: { origin: "https://evil.example", "x-client-id": CLIENT_A },
    });
    expect(res.status).toBe(403);
  });

  it("rejects a missing x-client-id header", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/likes/video-001`, {
      method: "POST",
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed (too short) x-client-id header", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/likes/video-001`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-client-id": "a1" },
    });
    expect(res.status).toBe(400);
  });

  it("records a like and returns the updated count", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/likes/video-001`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-client-id": CLIENT_A },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, liked: true, count: 1 });

    const rows = await env.LIKES.prepare("SELECT * FROM video_likes").all();
    expect(rows.results).toHaveLength(1);
  });

  it("is idempotent: a repeat like from the same client does not double-count", async () => {
    const first = await SELF.fetch(`${ORIGIN}/api/likes/video-001`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-client-id": CLIENT_A },
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, liked: true, count: 1 });

    const second = await SELF.fetch(`${ORIGIN}/api/likes/video-001`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-client-id": CLIENT_A },
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, liked: true, count: 1 });

    const rows = await env.LIKES.prepare("SELECT * FROM video_likes").all();
    expect(rows.results).toHaveLength(1);
  });

  it("unlikes a video, leaving other clients' likes intact", async () => {
    await SELF.fetch(`${ORIGIN}/api/likes/video-001`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-client-id": CLIENT_A },
    });
    await SELF.fetch(`${ORIGIN}/api/likes/video-001`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-client-id": CLIENT_B },
    });

    const res = await SELF.fetch(`${ORIGIN}/api/likes/video-001`, {
      method: "DELETE",
      headers: { origin: ORIGIN, "x-client-id": CLIENT_A },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, liked: false, count: 1 });

    const rows = await env.LIKES.prepare("SELECT client_id FROM video_likes").all<{
      client_id: string;
    }>();
    expect(rows.results).toEqual([{ client_id: CLIENT_B }]);
  });

  it("unliking a video the client never liked is a no-op, not an error", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/likes/video-999`, {
      method: "DELETE",
      headers: { origin: ORIGIN, "x-client-id": CLIENT_A },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, liked: false, count: 0 });
  });

  it("rate-limits after the per-minute cap is hit", async () => {
    for (let i = 0; i < 60; i++) {
      await env.LIKES.prepare(
        "INSERT INTO video_likes (video_id, client_id) VALUES (?, ?)",
      )
        .bind(`seed-video-${i}`, `seed-client-${i}`)
        .run();
    }

    const res = await SELF.fetch(`${ORIGIN}/api/likes/video-001`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-client-id": CLIENT_A },
    });
    expect(res.status).toBe(429);
  });

  it("rejects an id that fails the shape regex", async () => {
    // Path dot-segments (e.g. /api/likes/../etc) are normalized away by the
    // URL parser before the Worker ever sees them, so the only reachable way
    // to fail shape validation over real HTTP is an id that matches the
    // routing regex's character class but exceeds the 64-char length cap.
    const tooLong = "a".repeat(65);
    const res = await SELF.fetch(`${ORIGIN}/api/likes/${tooLong}`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-client-id": CLIENT_A },
    });
    expect(res.status).toBe(400);
  });

  it("rejects non-POST/DELETE methods", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/likes/video-001`, {
      method: "GET",
      headers: { origin: ORIGIN, "x-client-id": CLIENT_A },
    });
    expect(res.status).toBe(405);
  });
});

describe("GET /api/likes/batch", () => {
  // Redesigned after a Cloudflare architecture review: the original POST
  // design bound one parameter per requested video id into an IN (...)
  // clause, which hits D1's hard 100-bound-parameter limit at this
  // catalog's actual size (178 videos). The route now always returns counts
  // for the whole catalog, identically for every caller, via a
  // zero-bound-parameter query — and is edge-cached (Cache-Control:
  // max-age=20) since it now fires on every /feed page view. "Have I liked
  // this" is no longer answered server-side; the client tracks that itself.

  it("returns an empty likes object when nothing has been liked", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/likes/batch`, {
      method: "GET",
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, likes: {} });
  });

  it("returns per-video counts for the whole catalog, omitting zero-like videos", async () => {
    // video-001: 2 likes.
    await SELF.fetch(`${ORIGIN}/api/likes/video-001`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-client-id": CLIENT_A },
    });
    await SELF.fetch(`${ORIGIN}/api/likes/video-001`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-client-id": CLIENT_B },
    });
    // video-002: 1 like.
    await SELF.fetch(`${ORIGIN}/api/likes/video-002`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-client-id": CLIENT_B },
    });
    // video-003 is never liked, and must not appear in the response at all.

    const res = await SELF.fetch(`${ORIGIN}/api/likes/batch`, {
      method: "GET",
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      likes: { "video-001": 2, "video-002": 1 },
    });
  });

  it("sets a cache-control header with a max-age", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/likes/batch`, {
      method: "GET",
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age");
  });

  it("rejects non-GET methods", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/likes/batch`, {
      method: "POST",
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(405);
  });
});
