-- Per-device "like" events for feed videos (double-tap or the fist button
-- on src/components/VideoCard.astro, wired up in src/scripts/feed.ts).
-- One row per (video_id, client_id) pair — the composite primary key is
-- both the idempotency guarantee (a repeat "like" from the same device is
-- a no-op insert) and the aggregation source: like counts are always a
-- live COUNT(*)/GROUP BY over this table, there is no separate counter
-- column anywhere. client_id is an anonymous UUID the browser generates
-- and persists in localStorage — there is no user account system on this
-- site.
--
-- Lives in its own D1 database (blackdays-likes / blackdays-likes-staging),
-- separate from blackdays-takedowns and blackdays-video-submissions —
-- unlike those two, this table's aggregate counts ARE rendered on the
-- public site (via POST /api/likes/batch), even though individual rows
-- are still never exposed directly. Inspect directly with:
--   npx wrangler d1 execute blackdays-likes --remote \
--     --command "SELECT video_id, COUNT(*) FROM video_likes GROUP BY video_id"

CREATE TABLE IF NOT EXISTS video_likes (
  video_id    TEXT NOT NULL,
  client_id   TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (video_id, client_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_video_likes_video_id
  ON video_likes (video_id);

CREATE INDEX IF NOT EXISTS idx_video_likes_created_at
  ON video_likes (created_at DESC);
