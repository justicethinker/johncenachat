# Aside

A no-login website for private two-person chat. One-sided view: you only ever see the
other person's messages. Nothing is stored; the server relays ciphertext it cannot read.

The promise: no durable trail, and nothing in the chat proves who said what. It does
**not** promise that the other person can never copy what you wrote to them. See
[PRIVACY.md](PRIVACY.md) for the plain-language version and the known limits below.

## Commands

- `pnpm install`
- `pnpm build`
- `pnpm test` — unit + integration tests
- `pnpm test:e2e` — Playwright end-to-end privacy tests (two isolated browser contexts)
- `pnpm lint`
- `pnpm dev` — runs the relay server and the web dev server

## Deploy

Everything ships as two Docker containers (Caddy + relay) with no database and no
cache. Rooms live in the relay's process memory only.

```sh
cd deploy
docker compose up -d --build
```

That serves the site over HTTPS at `https://aside.localhost` using a local Caddy
certificate (`tls internal` in `deploy/Caddyfile`), so it works on any VPS or machine
without a public domain.

**Production:** set `ASIDE_DOMAIN=chat.example.com` (in the environment or a `.env`
file next to `docker-compose.yml`), delete the `tls internal` line from `Caddyfile`,
and open ports 80/443. Caddy then provisions a real Let's Encrypt certificate
automatically. Nothing else to configure.

### Railway (one command)

The project ships a Railway definition (`.railway/railway.ts`) with the same two
services: the relay (built from `deploy/Dockerfile.server`) and the static site.
Once the repo is on Railway, everything else is one command:

```sh
railway login
bash deploy/railway-setup.sh
```

The script links the project, applies the definition, generates the relay's
public domain, points the site build at it (`VITE_RELAY_WS`, baked in at build
time), and waits for the relay health check. Open the `web` service domain and
try `/new/4`.

Two things to know: the relay keeps rooms in process memory, so it must stay at
exactly 1 replica (already set in the definition — do not raise it), and Railway
sees only the same network-level metadata any host sees (see above).

### Verifying that nothing is logged

The relay uses `console.*` only for fatal startup errors, never for rooms,
connections, or IPs — a lint/test rule in `apps/server` fails the build if
`console.log`/`info`/`debug` appear in its sources. Caddy's access log is disabled
(`log { output discard }`).

To check yourself:

1. Start the stack and hold a chat open for a minute.
2. `docker compose logs` — it must show no connection, room, or request lines at all.
3. `docker compose exec caddy ls /data/caddy/logs` — no access log files exist.

### What the deployment can and cannot see

The hosting provider can still see network-level metadata: who connected to the
machine and when. The server itself never sees the URL fragment (the secret), the
encryption key, or any message plaintext — only opaque ciphertext frames, their
sizes, and their timing. Details in [PRIVACY.md](PRIVACY.md).

## Known limits

Stated honestly, not hidden:

- Screenshots and recordings cannot be blocked in a browser. The design makes them
  _low value_ (one-sided, anonymous, deniable), not impossible.
- The other person can still copy, retype, or remember what you wrote to them. “Messages vanish when their sender leaves” only removes messages from screens running the real client; screenshots, copies, retyped messages, and modified clients keep what they saw.
- In vanish-on-leave group rooms, group history gets thinner as people leave, and replies to vanished messages lose their context.
- The shared link is the only secret. Anyone who gets the full link before the
  second person joins can take that slot.
- The WhatsApp message containing the link is itself a record that you invited
  them. Share it by voice or in a disappearing chat if that matters.
- The hosting provider can see network-level IPs. A Tor onion service is a later
  option.

## Out of scope for v1

Edit/unsend, typing indicators, native apps with real screenshot blocking, Tor
onion service, Rust/WASM crypto core with forward secrecy.
