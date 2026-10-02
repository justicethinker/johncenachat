import { isBase64Url, isBase64UrlOfLength } from "./base64.js";
import { AUTH_TOKEN_BYTES, MAX_FRAME_BYTES } from "./constants.js";
import { isValidPeerId } from "./random.js";

/** Why the server destroyed a room. */
export type CloseReason = "peer_left" | "idle" | "expired" | "waiting_timeout";

/** Server error codes. */
export type ErrorCode =
  "room_full" | "bad_auth" | "bad_room" | "too_large" | "rate_limited" | "bad_format";

export type PeerState = "joined" | "away" | "back";

// --- Client -> server ---

export interface JoinFrame {
  type: "join";
  auth: string;
  peerId: string;
}

export interface MsgFrame {
  type: "msg";
  /** Per-connection counter, echoed back in `ack`. */
  n: number;
  /** Opaque ciphertext (base64url). The server must never parse it. */
  c: string;
}

export interface LeaveFrame {
  type: "leave";
}

export type ClientFrame = JoinFrame | MsgFrame | LeaveFrame;

// --- Server -> client ---

export interface JoinedFrame {
  type: "joined";
  label: string;
  peerLabel?: string;
  peers: number;
}

export interface PeerFrame {
  type: "peer";
  state: PeerState;
  peerLabel?: string;
}

export interface ServerMsgFrame {
  type: "msg";
  c: string;
}

export interface AckFrame {
  type: "ack";
  n: number;
}

export interface ClosedFrame {
  type: "closed";
  reason: CloseReason;
}

export interface ErrorFrame {
  type: "err";
  code: ErrorCode;
}

export type ServerFrame =
  JoinedFrame | PeerFrame | ServerMsgFrame | AckFrame | ClosedFrame | ErrorFrame;

const CLOSE_REASONS: ReadonlySet<string> = new Set<CloseReason>([
  "peer_left",
  "idle",
  "expired",
  "waiting_timeout",
]);
const ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  "room_full",
  "bad_auth",
  "bad_room",
  "too_large",
  "rate_limited",
  "bad_format",
]);
const PEER_STATES: ReadonlySet<string> = new Set<PeerState>(["joined", "away", "back"]);

const LABEL_RE = /^[0-9]{4}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseJson(raw: string): unknown | undefined {
  if (typeof raw !== "string" || raw.length > MAX_FRAME_BYTES) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Validate an inbound client frame. Returns null for anything malformed. */
export function parseClientFrame(raw: string): ClientFrame | null {
  const value = parseJson(raw);
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }
  switch (value.type) {
    case "join":
      if (
        isBase64UrlOfLength(value.auth, AUTH_TOKEN_BYTES) &&
        isValidPeerId(value.peerId) &&
        hasOnlyKeys(value, ["type", "auth", "peerId"])
      ) {
        return { type: "join", auth: value.auth, peerId: value.peerId };
      }
      return null;
    case "msg":
      if (
        isCounter(value.n) &&
        typeof value.c === "string" &&
        value.c.length > 0 &&
        value.c.length <= MAX_FRAME_BYTES &&
        isBase64Url(value.c) &&
        hasOnlyKeys(value, ["type", "n", "c"])
      ) {
        return { type: "msg", n: value.n, c: value.c };
      }
      return null;
    case "leave":
      if (hasOnlyKeys(value, ["type"])) {
        return { type: "leave" };
      }
      return null;
    default:
      return null;
  }
}

/** Validate an inbound server frame (used by the client). Returns null if malformed. */
export function parseServerFrame(raw: string): ServerFrame | null {
  const value = parseJson(raw);
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }
  switch (value.type) {
    case "joined": {
      if (
        typeof value.label === "string" &&
        LABEL_RE.test(value.label) &&
        isCounter(value.peers) &&
        value.peers >= 1 &&
        value.peers <= 2 &&
        hasOnlyKeys(value, ["type", "label", "peerLabel", "peers"]) &&
        (value.peerLabel === undefined ||
          (typeof value.peerLabel === "string" && LABEL_RE.test(value.peerLabel)))
      ) {
        const frame: JoinedFrame = { type: "joined", label: value.label, peers: value.peers };
        if (value.peerLabel !== undefined) {
          frame.peerLabel = value.peerLabel;
        }
        return frame;
      }
      return null;
    }
    case "peer": {
      if (
        typeof value.state === "string" &&
        PEER_STATES.has(value.state) &&
        hasOnlyKeys(value, ["type", "state", "peerLabel"]) &&
        (value.peerLabel === undefined ||
          (typeof value.peerLabel === "string" && LABEL_RE.test(value.peerLabel)))
      ) {
        const frame: PeerFrame = { type: "peer", state: value.state as PeerState };
        if (value.peerLabel !== undefined) {
          frame.peerLabel = value.peerLabel;
        }
        return frame;
      }
      return null;
    }
    case "msg":
      if (
        typeof value.c === "string" &&
        value.c.length > 0 &&
        value.c.length <= MAX_FRAME_BYTES &&
        isBase64Url(value.c) &&
        hasOnlyKeys(value, ["type", "c"])
      ) {
        return { type: "msg", c: value.c };
      }
      return null;
    case "ack":
      if (isCounter(value.n) && hasOnlyKeys(value, ["type", "n"])) {
        return { type: "ack", n: value.n };
      }
      return null;
    case "closed":
      if (
        typeof value.reason === "string" &&
        CLOSE_REASONS.has(value.reason) &&
        hasOnlyKeys(value, ["type", "reason"])
      ) {
        return { type: "closed", reason: value.reason as CloseReason };
      }
      return null;
    case "err":
      if (
        typeof value.code === "string" &&
        ERROR_CODES.has(value.code) &&
        hasOnlyKeys(value, ["type", "code"])
      ) {
        return { type: "err", code: value.code as ErrorCode };
      }
      return null;
    default:
      return null;
  }
}

/** Frame may only contain these keys (no smuggled metadata, required or optional). */
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
