import { defineRailway, github, project, service } from "railway/iac";

/**
 * Railway project definition. Apply with `railway config apply` (see
 * deploy/railway-setup.sh, which runs the whole flow end to end).
 *
 * Two services, both built from the repo root so the pnpm workspace
 * (apps + packages + root lockfile) is available to every build:
 *
 * - relay: the WebSocket server, built from deploy/Dockerfile.server.
 *   Rooms live in process memory, so it must stay at exactly 1 replica.
 *   It gets no settings beyond healthcheck/replicas here; Railway injects
 *   PORT and the server already listens on it on all interfaces.
 * - web: the static frontend, built with Nixpacks and served from
 *   apps/web/dist with single-page fallback for /r/* and /new/*.
 *
 * What this file deliberately does NOT contain:
 * - Public domains. Generated Railway domains cannot be declared in IaC;
 *   deploy/railway-setup.sh generates the relay domain and then sets
 *   VITE_RELAY_WS on web (a rebuild picks it up, since Vite bakes env
 *   vars at build time).
 */
export default defineRailway(() => {
  const relay = service("relay", {
    source: github("justicethinker/johncenachat", { branch: "main" }),
    env: {
      // The Dockerfile lives outside any single package, so point Railway
      // at it explicitly. The build context stays the repo root, matching
      // the COPY paths inside deploy/Dockerfile.server.
      RAILWAY_DOCKERFILE_PATH: "deploy/Dockerfile.server",
    },
    healthcheck: "/healthz",
    // Rooms live in process memory: exactly one replica, always.
    // Never raise this without adding shared room state first.
    replicas: 1,
  });

  const web = service("web", {
    source: github("justicethinker/johncenachat", { branch: "main" }),
    // The "..." builds @aside/protocol first; all sources are present
    // because the build runs from the repo root.
    build: "pnpm --filter @aside/web... build",
    // serve -s dist on $PORT (see the start script in apps/web/package.json).
    start: "pnpm --filter @aside/web start",
    healthcheck: "/",
    replicas: 1,
  });

  return project("johncenachat", {
    resources: [relay, web],
  });
});
