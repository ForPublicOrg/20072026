-- Takedown / correction requests submitted from /takedown/.
--
-- This table exists so the site can accept these requests without publishing
-- the maintainer's personal email address on a public page. Nothing here is
-- ever rendered back onto the site — it is a private inbox, read with:
--   npx wrangler d1 execute blackdays-takedowns --remote \
--     --command "SELECT * FROM takedown_requests ORDER BY created_at DESC"

CREATE TABLE IF NOT EXISTS takedown_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- What the request is about. `kind` is one of takedown|correction|context|other.
  kind          TEXT NOT NULL,
  -- Archive entry the request concerns, e.g. "video-012". Free text, because a
  -- requester may not know our ids and may describe the item instead.
  entry_ref     TEXT,
  -- How to reach the requester. Optional: someone may want to report a problem
  -- without identifying themselves, and we would still rather hear it.
  contact       TEXT,
  message       TEXT NOT NULL,
  -- Request metadata, kept for abuse triage only.
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  ip_country    TEXT,
  user_agent    TEXT,
  status        TEXT NOT NULL DEFAULT 'new'
);

CREATE INDEX IF NOT EXISTS idx_takedown_requests_created_at
  ON takedown_requests (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_takedown_requests_status
  ON takedown_requests (status);
