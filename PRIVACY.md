# Privacy: what the server sees and what it does not

This is the plain-language version. No crypto jargon required.

## What the server never sees

- **The secret in your link.** The part after `#` stays in your browser. Browsers
  never send URL fragments to servers, and the app strips it from the address bar
  right after reading it.
- **Your encryption key.** Derived in the browser from the secret; never leaves it.
- **Message text.** The server relays ciphertext — encrypted bytes it cannot read.
  It never parses, logs, or stores what a message says.
- **Your name or identity.** There are no accounts. You are a random 4-digit label
  that changes per room.

## What the server does see

- **That a connection happened**, and the network address it came from (this is
  visible to any server on the internet; it is used only in memory to rate-limit
  room creation and is never logged or stored).
- **The room ID** in the WebSocket path. Without the secret from the link it is
  useless for reading anything.
- **Message sizes and timing** — how many frames, how big, how often. Ciphertext
  length is partly controlled by padding, but timing is not hidden.
- **A hash of your link token** (one-way), used only to check that the second
  person holds the same link. It cannot be reversed into the token.

## What is stored, and for how long

Nothing is written to disk. Rooms exist in the server's memory and are destroyed
when either person leaves, after 10 minutes of silence, after 30 minutes waiting
for the second person, or after 6 hours at the absolute most. The server process
holds no room data once a room is destroyed. Caddy (the web server in front) has
access logging disabled, so it produces no request logs either.

## What this does not protect against

- **The other person.** They can copy, screenshot, record, or retype anything you
  send them. Both of you hold the same key, so nothing cryptographically proves
  who wrote what — that is deliberate (deniability), but it is not invisibility.
- **Screenshots and screen recordings.** A browser cannot block these.
- **The link itself.** Anyone who gets the full link before the second person
  joins can take that slot. The message you send the link through (WhatsApp, etc.)
  is itself a record.
- **Your hosting provider.** It can see network-level IPs and connection timing,
  including for the relay's plain HTTPS/WSS traffic endpoints. A Tor onion service
  is a later option.

The honest summary: **no durable trail on the server, and nothing in the chat
proves who said what — but the person you are talking to can still walk away with
your words.**
