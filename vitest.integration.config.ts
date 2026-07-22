import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Integration tests run src/worker.ts inside a real (local) Workers runtime
// via Miniflare — this is Cloudflare's own recommended way to test a Worker's
// fetch handler against real D1/R2 bindings, as opposed to unit tests, which
// never touch the Workers runtime. Nothing here ever reaches real Cloudflare
// infrastructure; D1/R2 are simulated locally regardless of the real
// database_id/bucket_name in wrangler.jsonc.
const takedownsMigrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
const submissionsMigrations = await readD1Migrations(
  path.join(import.meta.dirname, "migrations/video-submissions"),
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_TAKEDOWNS_MIGRATIONS: takedownsMigrations,
          TEST_SUBMISSIONS_MIGRATIONS: submissionsMigrations,
        },
      },
    }),
  ],
  test: {
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["./tests/integration/apply-migrations.ts"],
  },
});
