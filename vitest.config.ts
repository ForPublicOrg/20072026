import { defineConfig } from "vitest/config";

// Unit tests: pure logic only, no Cloudflare runtime. Workers integration
// tests live under tests/integration and run via vitest.integration.config.ts
// (a separate config because @cloudflare/vitest-pool-workers requires its
// own pool/runtime and can't share a test run with the default node pool).
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
