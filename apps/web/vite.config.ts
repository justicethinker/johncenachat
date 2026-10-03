import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    target: "es2022",
    sourcemap: false,
  },
  server: {
    // Dev only: the relay runs on :8080 (see apps/server).
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8080", ws: true },
      "/healthz": { target: "http://127.0.0.1:8080" },
    },
  },
  preview: {
    // Used by the Playwright e2e suite: serves the production build and
    // proxies the relay, mirroring how Caddy does it in production.
    port: 4173,
    strictPort: true,
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8080", ws: true },
      "/healthz": { target: "http://127.0.0.1:8080" },
    },
  },
});
