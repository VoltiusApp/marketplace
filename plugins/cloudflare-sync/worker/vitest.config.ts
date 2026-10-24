import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.toml" } })],
  test: {
    // Tests share one R2 bucket and clear it in beforeEach, so files must not run concurrently.
    fileParallelism: false,
  },
});
