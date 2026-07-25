CREATE TABLE IF NOT EXISTS video_likes (
  video_id    TEXT NOT NULL,
  client_id   TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (video_id, client_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_video_likes_video_id ON video_likes (video_id);
CREATE INDEX IF NOT EXISTS idx_video_likes_created_at ON video_likes (created_at DESC);
