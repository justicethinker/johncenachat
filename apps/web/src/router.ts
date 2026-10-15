import { useSyncExternalStore } from "react";

/**
 * Minimal hand-rolled router (no third-party dependency).
 * Routes: "/" (home), "/r/:roomId" (room) and "/new" or "/new/:count"
 * (quick start). The secret lives in the URL fragment, which is deliberately
 * NOT part of the route state.
 */

export type Route =
  | { kind: "home" }
  | { kind: "room"; roomId: string }
  | { kind: "quickStart"; count: number | null }
  | { kind: "notFound" };

export function parseRoute(pathname: string): Route {
  if (pathname === "/") {
    return { kind: "home" };
  }
  const match = /^\/r\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
  if (match) {
    return { kind: "room", roomId: match[1]! };
  }
  // The count is only parsed here; QuickStart decides whether it is a usable size.
  const quick = /^\/new(?:\/([^/]*))?\/?$/.exec(pathname);
  if (quick) {
    const segment = quick[1] ?? "";
    return { kind: "quickStart", count: /^\d+$/.test(segment) ? Number(segment) : null };
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

/**
 * Replaces the current history entry and tells the router, so the screen always
 * matches the address bar. Used by quick start to drop /new.
 */
export function replaceRoute(to: string): void {
  window.history.replaceState(null, "", to);
  for (const listener of listeners) {
    listener();
  }
}

let pendingInvite: string | null = null;

/** Quick start hands its invite link to the home screen, which shows it once. */
export function setPendingInvite(link: string): void {
  pendingInvite = link;
}

export function takePendingInvite(): string | null {
  const link = pendingInvite;
  pendingInvite = null;
  return link;
}

export function useRoute(): Route {
  const pathname = useSyncExternalStore(subscribeToRoute, getRoutePath);
  return parseRoute(pathname);
}
