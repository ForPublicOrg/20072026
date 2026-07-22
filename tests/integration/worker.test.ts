import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

// Integration tests for src/worker.ts, running against a real (local)
// Workers runtime with real D1/R2 bindings (see vitest.integration.config.ts
// + tests/integration/apply-migrations.ts). These exercise the request
// handling this repo can't afford to regress silently: the same-origin
// guard, the honeypot, rate limiting, and — most importantly — that a
// takedown or submission request actually lands in the database.

const ORIGIN = "https://20072026.com";

async function clearTables() {
  await env.TAKEDOWNS.exec("DELETE FROM takedown_requests");
  await env.SUBMISSIONS.exec("DELETE FROM video_submissions");
}

beforeEach(async () => {
  await clearTables();
});

describe("POST /api/takedown", () => {
  it("rejects non-POST methods", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/takedown`, { method: "GET" });
    expect(res.status).toBe(405);
  });

  it("rejects cross-origin requests", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/takedown`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ kind: "other", message: "hello there, world" }),
    });
    expect(res.status).toBe(403);
  });

  it("accepts a valid JSON submission and stores it in D1", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/takedown`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        kind: "correction",
        entry: "video-009",
        message: "The location listed for this entry is incorrect.",
        contact: "reporter@example.com",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const rows = await env.TAKEDOWNS.prepare(
      "SELECT kind, entry_ref, contact, message, status FROM takedown_requests",
    ).all();
    expect(rows.results).toEqual([
      {
        kind: "correction",
        entry_ref: "video-009",
        contact: "reporter@example.com",
        message: "The location listed for this entry is incorrect.",
        status: "new",
      },
    ]);
  });

  it("serves an HTML confirmation for the no-JS form fallback", async () => {
    const body = new URLSearchParams({
      kind: "other",
      message: "Submitted without JavaScript enabled.",
    });
    const res = await SELF.fetch(`${ORIGIN}/api/takedown`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Request received");

    const rows = await env.TAKEDOWNS.prepare("SELECT COUNT(*) AS n FROM takedown_requests").all<{
      n: number;
    }>();
    expect(rows.results[0].n).toBe(1);
  });

  it("silently accepts (but does not store) a honeypot-filled submission", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/takedown`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        kind: "other",
        message: "I am definitely a person filling this out.",
        website: "http://spam.example",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const rows = await env.TAKEDOWNS.prepare("SELECT COUNT(*) AS n FROM takedown_requests").all<{
      n: number;
    }>();
    expect(rows.results[0].n).toBe(0);
  });

  it("rejects an unrecognized kind", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/takedown`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ kind: "not-a-real-kind", message: "whatever whatever whatever" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a message that's too short", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/takedown`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ kind: "other", message: "short" }),
    });
    expect(res.status).toBe(400);
  });

  it("rate-limits after the per-minute cap is hit", async () => {
    for (let i = 0; i < 20; i++) {
      await env.TAKEDOWNS.prepare(
        `INSERT INTO takedown_requests (kind, message) VALUES ('other', 'pre-seeded row for rate limit test')`,
      ).run();
    }

    const res = await SELF.fetch(`${ORIGIN}/api/takedown`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ kind: "other", message: "this is the 21st request this minute" }),
    });
    expect(res.status).toBe(429);
  });
});

describe("POST /api/submit-video", () => {
  it("accepts a valid URL submission and stores it in D1", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/submit-video`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({
        mode: "url",
        url: "https://www.instagram.com/reel/example/",
        eventDate: "2026-07-20",
        description: "Footage from the protest march.",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const rows = await env.SUBMISSIONS.prepare(
      "SELECT submission_type, url, status FROM video_submissions",
    ).all();
    expect(rows.results).toEqual([
      { submission_type: "url", url: "https://www.instagram.com/reel/example/", status: "new" },
    ]);
  });

  it("rejects a malformed URL", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/submit-video`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ mode: "url", url: "not a url" }),
    });
    expect(res.status).toBe(400);
  });

  it("requires JavaScript (rejects non-JSON content types)", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/submit-video`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: "mode=url&url=https://example.com",
    });
    expect(res.status).toBe(400);
  });

  it("creates a pending row for upload mode and accepts the follow-up file PUT", async () => {
    const submitRes = await SELF.fetch(`${ORIGIN}/api/submit-video`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({
        mode: "upload",
        mimeType: "video/mp4",
        filename: "clip.mp4",
        fileSize: 1024,
      }),
    });
    expect(submitRes.status).toBe(200);
    const { id } = (await submitRes.json()) as { id: number };
    expect(id).toBeGreaterThan(0);

    const fileBytes = new Uint8Array(1024).fill(1);
    const uploadRes = await SELF.fetch(`${ORIGIN}/api/upload/${id}`, {
      method: "PUT",
      headers: {
        origin: ORIGIN,
        "content-type": "video/mp4",
        "content-length": String(fileBytes.byteLength),
      },
      body: fileBytes,
    });
    expect(uploadRes.status).toBe(200);
    expect(await uploadRes.json()).toEqual({ ok: true });

    const row = await env.SUBMISSIONS.prepare(
      "SELECT r2_key, file_size_bytes, mime_type FROM video_submissions WHERE id = ?",
    )
      .bind(id)
      .first<{ r2_key: string; file_size_bytes: number; mime_type: string }>();
    expect(row?.file_size_bytes).toBe(1024);
    expect(row?.mime_type).toBe("video/mp4");
    expect(row?.r2_key).toBeTruthy();

    const stored = await env.UPLOADS.get(row!.r2_key);
    expect(stored).not.toBeNull();
    expect(await stored!.arrayBuffer()).toEqual(fileBytes.buffer);
  });

  it("rejects an unsupported mime type for upload mode", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/submit-video`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({
        mode: "upload",
        mimeType: "application/pdf",
        filename: "not-a-video.pdf",
        fileSize: 1024,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an upload PUT for an unknown submission id", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/upload/999999`, {
      method: "PUT",
      headers: { origin: ORIGIN, "content-type": "video/mp4", "content-length": "10" },
      body: new Uint8Array(10),
    });
    expect(res.status).toBe(404);
  });
});

describe("static asset fallback", () => {
  it("serves the built site for non-API paths", async () => {
    const res = await SELF.fetch(`${ORIGIN}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});
