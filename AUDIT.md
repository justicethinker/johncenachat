# Privacy audit (spec step 11)

Date: 2026-10-03. Every item below was checked against the code and a running
deployment; evidence is named explicitly. Anything not proven is flagged.

How to reproduce: `pnpm install && pnpm lint && pnpm test && pnpm test:e2e`,
then `cd deploy && docker compose up -d --build` and inspect with `curl -sk -D -`.

---

## 1. No `console.*` logging of room data on the server — PASS

- `apps/server/src/privacy.test.ts` (runs in `pnpm test`, 4 tests green) reads
  every non-test file in `apps/server/src`: verbose console output
  (`log/info/debug/warn/trace/...`) is forbidden everywhere; `console.error` is
  allowed only in `index.ts`; `index.ts` may not even contain the string
  `roomId`.
- ESLint (`eslint.config.js`) applies the same ban as a hard error to
  `apps/server/src/**`, so `pnpm lint` fails on any new logging.
- Runtime evidence: after a full two-person chat through the deployed stack,
  `docker compose logs` showed only Caddy's one-time certificate-install lines —
  no connections, rooms, requests, or IPs. `docker compose exec caddy` confirms
  no `/data/caddy/logs` directory exists (access log disabled in Caddyfile).

## 2. No browser storage APIs in the client — PASS

- `apps/web/src/privacy.test.ts` (4 tests green) greps all client sources for
  `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`,
  `cookieStore`, and `serviceWorker`; the build fails if any appears. It also
  forbids `fetch(`, `XMLHttpRequest`, `sendBeacon`, inline `style=`, `eval`,
  and absolute `http(s)` URLs in sources.
- ESLint bans the storage identifiers as a hard error in `apps/web/src/**`
  (`pnpm lint` green).
- The secret lives in module memory only; `history.replaceState` strips the
  fragment after read (asserted by the e2e test in item 4).

## 3. No requests to third-party hosts — PASS

- Built bundle inspected: `grep -oE 'https?://...'` over
  `apps/web/dist/assets/*.js` and `dist/index.html` finds only
  `http://www.w3.org/...` XML/SVG namespace identifiers and
  `https://react.dev/errors/` — both are React string constants that are never
  fetched. No other absolute URLs exist.
- `index.html` has no absolute URLs at all, and every `src`/`href` is
  root-relative (asserted by `apps/web/src/privacy.test.ts`).
- Network evidence: the e2e suite records **every** HTTP request from both
  browser contexts and now asserts each one is same-origin (or `data:`);
  `pnpm test:e2e` — 3/3 passed.
- CSP (`default-src 'none'; connect-src 'self'; ...`) would block any stray
  request even if one were introduced.
- Flagged (not a request): the `https://react.dev/errors/` string would only be
  visited if a human copied it out of a production error message.

## 4. Fragment never appears in any request or frame — PASS

- e2e (`e2e/tests/privacy.spec.ts`, test 1) captures all HTTP requests and all
  WebSocket frames (sent and received) in both isolated contexts and asserts:
  the 43-char secret appears in none of them; no plaintext message text
  appears in any frame; and after load `location.hash` is empty (fragment
  stripped via `history.replaceState`).
- Browsers never include fragments in requests by construction, and the server
  has no code path that reads one; the wire format (item 3's recording) proves
  it empirically.
- Note: WebSocket frames are recorded by Playwright at the endpoint, i.e. this
  is the browser's own view of what left the tab — equivalent to the network
  tab.

## 5. Server holds no room data after rooms close — PASS

- `apps/server/src/integration.test.ts:241` — "holds no rooms in memory after
  everyone has left" (real server, two `ws` clients).
- `apps/server/src/manager.test.ts:419` — "leaves no rooms behind once
  everyone is gone" (unit level, injected clock).
- All 32 server tests pass (`pnpm test`). Rooms are a `Map<roomId, Room>` in
  process memory; there is no file, database, or cache dependency anywhere in
  `apps/server` (dependencies: `ws` + `@aside/protocol` only), so nothing can
  persist.
- e2e test 4 confirms the destroy path end to end: closing context A ends B's
  chat with `peer_left`.

## 6. CSP, referrer policy, and cache headers present — PASS

Measured on the deployed stack (`docker compose up`, `curl -sk -D -`):

- `GET /` and `GET /r/anything` →
  `content-security-policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  `referrer-policy: no-referrer`, `x-content-type-options: nosniff`,
  `cache-control: no-store`.
- `GET /assets/index-*.js` → same CSP, referrer policy, and nosniff.
- `/` and `/r/*` return byte-identical HTML (`curl | cmp` → identical), so
  every room link serves the same generic, metadata-free document.

## 7. Dependency list is minimal and each dependency is justified — PASS

Runtime dependencies (production images):

| Package              | Where       | Why                                                      |
| -------------------- | ----------- | -------------------------------------------------------- |
| `ws`                 | server      | The WebSocket implementation; the only server dependency |
| `react`, `react-dom` | web         | The UI framework (spec-mandated)                         |
| `@aside/protocol`    | server, web | Workspace package: shared types + crypto                 |

`packages/protocol` has **zero** runtime dependencies — all cryptography is
browser/Node WebCrypto (`crypto.subtle`). No crypto libraries, no analytics, no
HTTP clients, no logging frameworks.

Dev-only: `typescript`, `vitest`, `eslint` + `typescript-eslint` + `@eslint/js`,
`prettier`, `vite` + `@vitejs/plugin-react`, `jsdom`, `@testing-library/*`,
`tsx`, `@types/*`, `@playwright/test`. Each is standard tooling for its step;
none ships to users or runs in production containers.

---

## Summary

| #   | Item                                | Result |
| --- | ----------------------------------- | ------ |
| 1   | No `console.*` logging of room data | PASS   |
| 2   | No browser storage APIs             | PASS   |
| 3   | No third-party requests             | PASS   |
| 4   | Fragment never on the wire          | PASS   |
| 5   | No room data after close            | PASS   |
| 6   | CSP / referrer / cache headers      | PASS   |
| 7   | Minimal, justified dependencies     | PASS   |

**Flagged limitations (not failures, but honest caveats):**

- The hosting provider still sees network-level IPs and connection timing
  (documented in README and PRIVACY.md); a Tor onion service is future work.
- The server can observe ciphertext sizes and timing; padding mitigates size
  leakage but does not hide timing.
- The `https://react.dev/errors/` string inside the React bundle is inert —
  never requested automatically.
- Header and log checks were run against the local Docker deployment
  (`tls internal`); a production domain follows the identical Caddyfile path
  minus the `tls internal` line, but was not exercised here.
