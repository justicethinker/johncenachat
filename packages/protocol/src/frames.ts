import { isBase64Url, isBase64UrlOfLength } from "./base64.js";
import { AUTH_TOKEN_BYTES, MAX_FRAME_BYTES, MAX_PEERS } from "./constants.js";
import { isValidPeerId } from "./random.js";

/** Why the server destroyed a room. */
export type CloseReason =
  "peer_left" | "idle" | "expired" | "waiting_timeout" | "creator_left" | "closed_by_creator";

/** Server error codes. */
export type ErrorCode =
  | "room_full"
  | "bad_auth"
  | "bad_room"
  | "too_large"
  | "rate_limited"
  | "bad_format"
  | "room_locked"
  | "bad_cap"
  | "not_creator";

export type PeerState = "joined" | "left" | "away" | "back";

// --- Client -> server ---

export interface JoinFrame {
  type: "join";
  auth: string;
  peerId: string;
  /** Group size cap, honoured only for the first joiner (the creator). */
  cap?: number;
  /** Whether messages vanish after their sender leaves; stored from the creator only. */
  vanish?: boolean;
}

export interface MsgFrame {
  type: "msg";
  /** Per-connection counter, echoed back in `ack`. */
  n: number;
  /** Opaque ciphertext (base64url). The server must never parse it. */
  c: string;
}

export interface LockFrame {
  type: "lock";
}

export interface CloseFrame {
  type: "close";
}

export interface LeaveFrame {
  type: "leave";
}

export type ClientFrame = JoinFrame | MsgFrame | LockFrame | CloseFrame | LeaveFrame;

// --- Server -> client ---

export interface JoinedFrame {
  type: "joined";
  label: string;
  members: string[];
  cap: number;
  locked: boolean;
  isCreator: boolean;
  /** Creator-selected room metadata; the relay does not enforce it. */
  vanish: boolean;
}

export interface PeerFrame {
  type: "peer";
  state: PeerState;
  label: string;
  count: number;
}

export interface ServerMsgFrame {
  type: "msg";
  from: string;
  c: string;
}

export interface AckFrame {
  type: "ack";
  n: number;
}

export interface LockedFrame {
  type: "locked";
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
  JoinedFrame | PeerFrame | ServerMsgFrame | AckFrame | LockedFrame | ClosedFrame | ErrorFrame;

const CLOSE_REASONS: ReadonlySet<string> = new Set<CloseReason>([
  "peer_left",
  "idle",
  "expired",
  "waiting_timeout",
  "creator_left",
  "closed_by_creator",
]);

const ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  "room_full",
  "bad_auth",
  "bad_room",
  "too_large",
  "rate_limited",
  "bad_format",
  "room_locked",
  "bad_cap",
  "not_creator",
]);

const PEER_STATES: ReadonlySet<string> = new Set<PeerState>(["joined", "left", "away", "back"]);

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
    case "join": {
      if (!isBase64UrlOfLength(value.auth, AUTH_TOKEN_BYTES) || !isValidPeerId(value.peerId)) {
        return null;
      }
      // A client-provided `from` would let any member impersonate another since
      // all members share one key. The server stamps `from`; clients may not.
      if ("from" in value) {
        return null;
      }
      const cap = value.cap;
      const vanish = value.vanish;
      // Preserve numeric cap input for RoomManager: a creator's invalid value
      // gets `bad_cap`, while later joiners' values are ignored.
      if (cap !== undefined && typeof cap !== "number") {
        return null;
      }
      if (vanish !== undefined && typeof vanish !== "boolean") {
        return null;
      }
      if (!hasOnlyKeys(value, ["type", "auth", "peerId", "cap", "vanish"])) {
        return null;
      }
      return {
        type: "join",
        auth: value.auth,
        peerId: value.peerId,
        ...(cap === undefined ? {} : { cap: cap as number }),
        ...(vanish === undefined ? {} : { vanish: vanish as boolean }),
      };
    }
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
    case "lock":
      if (hasOnlyKeys(value, ["type"])) {
        return { type: "lock" };
      }
      return null;
    case "close":
      if (hasOnlyKeys(value, ["type"])) {
        return { type: "close" };
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
      if (typeof value.label !== "string" || !LABEL_RE.test(value.label)) {
        return null;
      }
      if (
        !Array.isArray(value.members) ||
        !value.members.every((member) => typeof member === "string" && LABEL_RE.test(member))
      ) {
        return null;
      }
      if (
        !isCounter(value.cap) ||
        value.cap < 2 ||
        value.cap > MAX_PEERS ||
        typeof value.locked !== "boolean" ||
        typeof value.isCreator !== "boolean" ||
        typeof value.vanish !== "boolean"
      ) {
        return null;
      }
      if (
        !hasOnlyKeys(value, ["type", "label", "members", "cap", "locked", "isCreator", "vanish"])
      ) {
        return null;
      }
      return {
        type: "joined",
        label: value.label,
        members: value.members as string[],
        cap: value.cap as number,
        locked: value.locked as boolean,
        isCreator: value.isCreator as boolean,
        vanish: value.vanish as boolean,
      };
    }
    case "peer": {
      if (
        typeof value.state !== "string" ||
        !PEER_STATES.has(value.state) ||
        typeof value.label !== "string" ||
        !LABEL_RE.test(value.label) ||
        !isCounter(value.count) ||
        value.count < 1 ||
        value.count > MAX_PEERS
      ) {
        return null;
      }
      if (!hasOnlyKeys(value, ["type", "state", "label", "count"])) {
        return null;
      }
      const frame: PeerFrame = {
        type: "peer",
        state: value.state as PeerState,
        label: value.label,
        count: value.count,
      };
      return frame;
    }
    case "msg":
      if (typeof value.from !== "string" || !LABEL_RE.test(value.from)) {
        return null;
      }
      if (
        typeof value.c !== "string" ||
        value.c.length === 0 ||
        value.c.length > MAX_FRAME_BYTES ||
        !isBase64Url(value.c)
      ) {
        return null;
      }
      if (!hasOnlyKeys(value, ["type", "from", "c"])) {
        return null;
      }
      return { type: "msg", from: value.from, c: value.c };
    case "ack":
      if (isCounter(value.n) && hasOnlyKeys(value, ["type", "n"])) {
        return { type: "ack", n: value.n };
      }
      return null;
    case "locked": {
      if (hasOnlyKeys(value, ["type"])) {
        return { type: "locked" };
      }
      return null;
    }
    case "closed": {
      if (typeof value.reason !== "string" || !CLOSE_REASONS.has(value.reason)) {
        return null;
      }
      if (!hasOnlyKeys(value, ["type", "reason"])) {
        return null;
      }
      return { type: "closed", reason: value.reason as CloseReason };
    }
    case "err": {
      if (typeof value.code !== "string" || !ERROR_CODES.has(value.code)) {
        return null;
      }
      if (!hasOnlyKeys(value, ["type", "code"])) {
        return null;
      }
      return { type: "err", code: value.code as ErrorCode };
    }
    default:
      return null;
  }
}

/** Frame may only contain these keys (no smuggled metadata, required or optional). */
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
