import { useSyncExternalStore } from "react";

/**
 * Minimal hand-rolled router (no third-party dependency).
 * Routes: "/" (home) and "/r/:roomId" (room). The secret lives in the
 * URL fragment, which is deliberately NOT part of the route state.
 */

export type Route = { kind: "home" } | { kind: "room"; roomId: string } | { kind: "notFound" };

export function parseRoute(pathname: string): Route {
  if (pathname === "/") {
    return { kind: "home" };
  }
  const match = /^\/r\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
  if (match) {
    return { kind: "room", roomId: match[1]! };
  }
  return { kind: "notFound" };
}

const listeners = new Set<() => void>();

export function subscribeToRoute(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

export function getRoutePath(): string {
  return window.location.pathname;
}

/** Client-side navigation. `to` may include a fragment (used to enter a room). */
export function navigate(to: string): void {
  window.history.pushState(null, "", to);
  for (const listener of listeners) {
    listener();
  }
}

export function useRoute(): Route {
  const pathname = useSyncExternalStore(subscribeToRoute, getRoutePath);
  return parseRoute(pathname);
}
