import { createHash, timingSafeEqual } from "node:crypto";
import {
  IDLE_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  MAX_ROOMS,
  MAX_ROOM_AGE_MS,
  MSG_RATE_BURST,
  MSG_RATE_PER_SECOND,
  RECONNECT_GRACE_MS,
  ROOM_CREATE_LIMIT_PER_IP,
  ROOM_CREATE_WINDOW_MS,
  WAITING_TIMEOUT_MS,
  generateLabel,
  isValidPeerId,
  isValidRoomId,
  type CloseReason,
  type ErrorCode,
  type JoinedFrame,
  type MsgFrame,
  type ServerFrame,
} from "@aside/protocol";
import { type Clock, systemClock } from "./clock.js";
import { TokenBucket, WindowCounter } from "./rateLimit.js";

/**
 * The relay. Holds rooms in process memory only, forwards opaque ciphertext
 * to the *other* peer, and never parses, logs or stores it (spec section 7).
 */
export interface Connection {
  send(frame: ServerFrame): void;
  close(): void;
}

interface Peer {
  peerId: string;
  label: string;
  socket: Connection | null;
  awaySince: number | null;
  rate: TokenBucket;
}

interface Room {
  id: string;
  /** SHA-256 of the first joiner's authToken; later joiners must match. */
  authHash: Buffer;
  peers: Map<string, Peer>;
  createdAt: number;
  lastActivity: number;
}

export type JoinResult = { ok: true; label: string } | { ok: false; code: ErrorCode };

export interface RoomManagerOptions {
  clock?: Clock;
  maxRooms?: number;
}

function hashAuth(auth: string): Buffer {
  return createHash("sha256").update(auth, "utf8").digest();
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly clock: Clock;
  private readonly maxRooms: number;
  private readonly createLimiter: WindowCounter;

  constructor(options: RoomManagerOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.maxRooms = options.maxRooms ?? MAX_ROOMS;
    this.createLimiter = new WindowCounter(
      this.clock,
      ROOM_CREATE_LIMIT_PER_IP,
      ROOM_CREATE_WINDOW_MS,
    );
  }

  /** Number of rooms currently held in memory. */
  get size(): number {
    return this.rooms.size;
  }

  join(roomId: string, auth: string, peerId: string, ip: string, conn: Connection): JoinResult {
    if (!isValidRoomId(roomId)) {
      return { ok: false, code: "bad_room" };
    }
    if (!isValidPeerId(peerId)) {
      return { ok: false, code: "bad_format" };
    }
    // auth must be a well-formed 32-byte token (format only; never decrypted).
    if (typeof auth !== "string" || auth.length !== 43) {
      return { ok: false, code: "bad_auth" };
    }

    let room = this.rooms.get(roomId);
    if (!room) {
      if (this.rooms.size >= this.maxRooms) {
        return { ok: false, code: "room_full" };
      }
      if (!this.createLimiter.allow(ip)) {
        return { ok: false, code: "rate_limited" };
      }
      const now = this.clock.now();
      room = {
        id: roomId,
        authHash: hashAuth(auth),
        peers: new Map(),
        createdAt: now,
        lastActivity: now,
      };
      this.rooms.set(roomId, room);
    } else if (!safeEqual(room.authHash, hashAuth(auth))) {
      return { ok: false, code: "bad_auth" };
    }

    const now = this.clock.now();
    let peer = room.peers.get(peerId);
    const isReconnect = peer !== undefined;
    let wasAway = false;

    if (peer) {
      if (peer.socket && peer.socket !== conn) {
        peer.socket.close();
      }
      peer.socket = conn;
      wasAway = peer.awaySince !== null;
      peer.awaySince = null;
    } else {
      if (room.peers.size >= 2) {
        return { ok: false, code: "room_full" };
      }
      const taken = new Set<string>();
      for (const existing of room.peers.values()) {
        taken.add(existing.label);
      }
      peer = {
        peerId,
        label: generateLabel(taken),
        socket: conn,
        awaySince: null,
        rate: new TokenBucket(this.clock, MSG_RATE_PER_SECOND, MSG_RATE_BURST),
      };
      room.peers.set(peerId, peer);
    }

    const other = this.otherPeer(room, peer);
    const joined: JoinedFrame = {
      type: "joined",
      label: peer.label,
      peers: room.peers.size,
      ...(other ? { peerLabel: other.label } : {}),
    };
    conn.send(joined);

    if (other) {
      if (!isReconnect && other.socket) {
        other.socket.send({ type: "peer", state: "joined", peerLabel: peer.label });
      } else if (isReconnect && wasAway && other.socket) {
        other.socket.send({ type: "peer", state: "back", peerLabel: peer.label });
      }
      if (other.socket === null) {
        // Tell the joiner that the other person is currently disconnected.
        conn.send({ type: "peer", state: "away", peerLabel: other.label });
      }
    }

    if (room.peers.size === 2) {
      // Both people have joined: give the pair a fresh idle window.
      room.lastActivity = now;
    }
    return { ok: true, label: peer.label };
  }

  /** Forward opaque ciphertext to the *other* peer; never echo to the sender. */
  msg(roomId: string, peerId: string, conn: Connection, frame: MsgFrame): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const peer = room.peers.get(peerId);
    if (!peer || peer.socket !== conn) return;

    if (frame.c.length > MAX_FRAME_BYTES) {
      conn.send({ type: "err", code: "too_large" });
      return;
    }
    if (!peer.rate.tryConsume()) {
      conn.send({ type: "err", code: "rate_limited" });
      return;
    }
    room.lastActivity = this.clock.now();

    const other = this.otherPeer(room, peer);
    if (other && other.socket) {
      other.socket.send({ type: "msg", c: frame.c });
      conn.send({ type: "ack", n: frame.n });
    }
    // No connected peer (waiting room / peer away): drop silently, no ack.
  }

  /** Explicit exit: the room is destroyed for everyone. */
  leave(roomId: string, peerId: string, conn: Connection): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const peer = room.peers.get(peerId);
    if (!peer || peer.socket !== conn) return;
    this.destroy(room, "peer_left");
  }

  /** Socket dropped: keep the room for the grace window so the peer can return. */
  disconnect(roomId: string, peerId: string, conn: Connection): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const peer = room.peers.get(peerId);
    if (!peer || peer.socket !== conn) return;
    peer.socket = null;
    peer.awaySince = this.clock.now();
    const other = this.otherPeer(room, peer);
    if (other && other.socket) {
      other.socket.send({ type: "peer", state: "away", peerLabel: peer.label });
    }
  }

  /** Reaper: runs every REAPER_INTERVAL_MS (or manually in tests). */
  tick(): void {
    const now = this.clock.now();
    this.createLimiter.prune();

    for (const room of Array.from(this.rooms.values())) {
      if (now - room.createdAt >= MAX_ROOM_AGE_MS) {
        this.destroy(room, "expired");
        continue;
      }
      let graceExpired = false;
      for (const peer of room.peers.values()) {
        if (
          peer.socket === null &&
          peer.awaySince !== null &&
          now - peer.awaySince >= RECONNECT_GRACE_MS
        ) {
          graceExpired = true;
          break;
        }
      }
      if (graceExpired) {
        this.destroy(room, "peer_left");
        continue;
      }
      if (room.peers.size < 2 && now - room.createdAt >= WAITING_TIMEOUT_MS) {
        this.destroy(room, "waiting_timeout");
        continue;
      }
      if (room.peers.size === 2 && now - room.lastActivity >= IDLE_TIMEOUT_MS) {
        this.destroy(room, "idle");
      }
    }
  }

  private destroy(room: Room, reason: CloseReason): void {
    this.rooms.delete(room.id);
    for (const peer of room.peers.values()) {
      if (peer.socket) {
        peer.socket.send({ type: "closed", reason });
        peer.socket.close();
        peer.socket = null;
      }
      peer.awaySince = null;
    }
  }

  private otherPeer(room: Room, peer: Peer): Peer | null {
    for (const candidate of room.peers.values()) {
      if (candidate.peerId !== peer.peerId) {
        return candidate;
      }
    }
    return null;
  }
}
