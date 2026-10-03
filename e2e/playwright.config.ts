import { defineConfig } from "@playwright/test";

/**
 * E2E runs against the *production* build: `vite preview` serves the built
 * site and proxies /ws to the relay, exactly like Caddy will in production.
 * Run via `pnpm test:e2e` (builds first).
 */
export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Sequential: every worker would share the per-IP room-creation limit.
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
  },
  webServer: [
    {
      command: "pnpm --filter @aside/server start",
      url: "http://127.0.0.1:8080/healthz",
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: "pnpm --filter @aside/web preview",
      url: "http://127.0.0.1:4173/",
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
