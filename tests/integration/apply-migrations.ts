import { applyD1Migrations, env } from "cloudflare:test";

// Runs once before the integration suite: applies the same migration files
// used against the real databases (migrations/, migrations/video-submissions)
// to this test run's local D1 instances, so tests exercise the real schema.
await applyD1Migrations(env.TAKEDOWNS, env.TEST_TAKEDOWNS_MIGRATIONS);
await applyD1Migrations(env.SUBMISSIONS, env.TEST_SUBMISSIONS_MIGRATIONS);
