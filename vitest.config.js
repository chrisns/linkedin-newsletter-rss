import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      // The KV namespace is commented out in wrangler.toml until one is
      // created in the account. Bind a simulated one here so the popularity
      // path is still covered.
      miniflare: { kvNamespaces: ["POPULAR"] },
    }),
  ],
});
