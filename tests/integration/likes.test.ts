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

describe("POST /api/likes/batch", () => {
  it("returns counts and per-client liked status for each requested id", async () => {
    // video-001: 2 likes total, one of them from the calling client (A).
    await SELF.fetch(`${ORIGIN}/api/likes/video-001`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-client-id": CLIENT_A },
    });
    await SELF.fetch(`${ORIGIN}/api/likes/video-001`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-client-id": CLIENT_B },
    });
    // video-002: 1 like, not from the calling client.
    await SELF.fetch(`${ORIGIN}/api/likes/video-002`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-client-id": CLIENT_B },
    });

    const res = await SELF.fetch(`${ORIGIN}/api/likes/batch`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", "x-client-id": CLIENT_A },
      body: JSON.stringify({ ids: ["video-001", "video-002", "video-999"] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      likes: {
        "video-001": { count: 2, liked: true },
        "video-002": { count: 1, liked: false },
        "video-999": { count: 0, liked: false },
      },
    });
  });

  it("succeeds with liked: false for every entry when x-client-id is missing", async () => {
    await SELF.fetch(`${ORIGIN}/api/likes/video-001`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-client-id": CLIENT_A },
    });

    const res = await SELF.fetch(`${ORIGIN}/api/likes/batch`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ ids: ["video-001"] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      likes: { "video-001": { count: 1, liked: false } },
    });
  });

  it("rejects cross-origin requests", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/likes/batch`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ ids: ["video-001"] }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects malformed JSON", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/likes/batch`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a body where ids is not an array", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/likes/batch`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ ids: "video-001" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects more than 2000 ids", async () => {
    const ids = Array.from({ length: 2001 }, (_, i) => `video-${i}`);
    const res = await SELF.fetch(`${ORIGIN}/api/likes/batch`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    expect(res.status).toBe(400);
  });

  it("silently drops malformed ids rather than erroring the whole batch", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/likes/batch`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ ids: ["video-001", "UPPERCASE", "has spaces", 42] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      likes: { "video-001": { count: 0, liked: false } },
    });
  });

  it("returns an empty likes object immediately when ids is empty", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/likes/batch`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ ids: [] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, likes: {} });
  });

  it("rejects non-POST methods", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/likes/batch`, {
      method: "GET",
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(405);
  });
});
