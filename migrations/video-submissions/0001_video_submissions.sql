-- Video contribution requests submitted from the home page ("Submit a video"
-- section, src/pages/index.astro). Covers both modes:
--   - submission_type = 'url'    — a link to an existing public post.
--   - submission_type = 'upload' — raw footage streamed into the private
--     `blackdays-uploads` R2 bucket by src/worker.ts; r2_key is NULL until
--     the upload step (PUT /api/upload/:id) completes.
--
-- Lives in its own D1 database (blackdays-video-submissions /
-- blackdays-video-submissions-staging), separate from blackdays-takedowns,
-- so the two request types never share a table. Nothing here is ever
-- rendered back onto the public site — read/triage with
-- scripts/admin-requests.mjs (list/update/download), or directly with:
--   npx wrangler d1 execute blackdays-video-submissions --remote \
--     --command "SELECT * FROM video_submissions ORDER BY created_at DESC"

CREATE TABLE IF NOT EXISTS video_submissions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_type   TEXT NOT NULL DEFAULT 'url' CHECK (submission_type IN ('url', 'upload')),
  -- Set when submission_type = 'url'.
  url               TEXT,
  -- Set once the file has actually landed in R2 (submission_type = 'upload').
  -- NULL between the two upload steps — see src/worker.ts handleVideoUpload.
  r2_key            TEXT,
  file_size_bytes   INTEGER,
  mime_type         TEXT,
  original_filename TEXT,
  -- User-reported date/time the footage was captured. Free text / ISO
  -- string, never verified — this is a claim from the submitter, not a fact.
  event_date        TEXT,
  description       TEXT,
  -- How to reach the submitter. Optional, same convention as takedown_requests.
  contact           TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  ip_country        TEXT,
  user_agent        TEXT,
  status            TEXT NOT NULL DEFAULT 'new'
                       CHECK (status IN ('new', 'reviewing', 'approved', 'rejected', 'done'))
);

CREATE INDEX IF NOT EXISTS idx_video_submissions_created_at
  ON video_submissions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_video_submissions_status
  ON video_submissions (status);
