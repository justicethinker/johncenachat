import { createHash, timingSafeEqual } from "node:crypto";
import {
  CREATOR_GRACE_MS,
  IDLE_TIMEOUT_MS,
  MAX_DEAD_ROOMS,
  MAX_FRAME_BYTES,
  MAX_PEERS,
  MAX_ROOMS,
  MAX_ROOM_AGE_MS,
  MSG_RATE_BURST,
  MSG_RATE_PER_SECOND,
  RECONNECT_GRACE_MS,
  ROOM_CREATE_LIMIT_PER_IP,
  ROOM_CREATE_WINDOW_MS,
  ROOM_FANOUT_RATE_PER_SECOND,
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

/** The relay forwards ciphertext, and never parses, logs or stores it. */
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
  authHash: Buffer;
  peers: Map<string, Peer>;
  /** Kept for the room lifetime, so departed labels are never reused. */
  usedLabels: Set<string>;
  creatorPeerId: string;
  cap: number;
  /** Creator-selected display behavior; relay only stores and returns it. */
  vanish: boolean;
  locked: boolean;
  createdAt: number;
  lastActivity: number;
  hadMultipleConnected: boolean;
  singletonSince: number | null;
  fanout: TokenBucket;
}

interface DeadRoom {
  authHash: Buffer;
  reason: CloseReason;
}

export type JoinResult =
  { ok: true; label: string } | { ok: false; code: ErrorCode } | { ok: false; closed: CloseReason };

export interface RoomManagerOptions {
  clock?: Clock;
  maxRooms?: number;
  maxDeadRooms?: number;
}

function hashAuth(auth: string): Buffer {
  return createHash("sha256").update(auth, "utf8").digest();
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function connectedCount(room: Room): number {
  let count = 0;
  for (const peer of room.peers.values()) if (peer.socket !== null) count += 1;
  return count;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly deadRooms = new Map<string, DeadRoom>();
  private readonly clock: Clock;
  private readonly maxRooms: number;
  private readonly maxDeadRooms: number;
  private readonly createLimiter: WindowCounter;

  constructor(options: RoomManagerOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.maxRooms = options.maxRooms ?? MAX_ROOMS;
    this.maxDeadRooms = options.maxDeadRooms ?? MAX_DEAD_ROOMS;
    this.createLimiter = new WindowCounter(
      this.clock,
      ROOM_CREATE_LIMIT_PER_IP,
      ROOM_CREATE_WINDOW_MS,
    );
  }

  get size(): number {
    return this.rooms.size;
  }

  get deadSize(): number {
    return this.deadRooms.size;
  }

  join(
    roomId: string,
    auth: string,
    peerId: string,
    ip: string,
    conn: Connection,
    requestedCap?: number,
    requestedVanish?: boolean,
  ): JoinResult {
    if (!isValidRoomId(roomId)) return { ok: false, code: "bad_room" };
    if (!isValidPeerId(peerId)) return { ok: false, code: "bad_format" };
    if (typeof auth !== "string" || auth.length !== 43) {
      return { ok: false, code: "bad_auth" };
    }
    let room = this.rooms.get(roomId);
    if (!room) {
      const dead = this.deadRooms.get(roomId);
      if (dead) {
        return safeEqual(dead.authHash, hashAuth(auth))
          ? { ok: false, closed: dead.reason }
          : { ok: false, code: "bad_auth" };
      }
      if (
        requestedCap !== undefined &&
        (!Number.isSafeInteger(requestedCap) || requestedCap < 2 || requestedCap > MAX_PEERS)
      ) {
        return { ok: false, code: "bad_cap" };
      }
      if (this.rooms.size >= this.maxRooms) return { ok: false, code: "room_full" };
      if (!this.createLimiter.allow(ip)) return { ok: false, code: "rate_limited" };

      const now = this.clock.now();
      room = {
        id: roomId,
        authHash: hashAuth(auth),
        peers: new Map(),
        usedLabels: new Set(),
        creatorPeerId: peerId,
        cap: requestedCap ?? MAX_PEERS,
        vanish: requestedVanish ?? true,
        locked: false,
        createdAt: now,
        lastActivity: now,
        hadMultipleConnected: false,
        singletonSince: null,
        fanout: new TokenBucket(
          this.clock,
          ROOM_FANOUT_RATE_PER_SECOND,
          ROOM_FANOUT_RATE_PER_SECOND,
        ),
      };
      this.rooms.set(roomId, room);
    } else if (!safeEqual(room.authHash, hashAuth(auth))) {
      return { ok: false, code: "bad_auth" };
    }

    const now = this.clock.now();
    const creator = room.peers.get(room.creatorPeerId);
    if (
      creator &&
      creator.socket === null &&
      creator.awaySince !== null &&
      now - creator.awaySince >= CREATOR_GRACE_MS
    ) {
      this.destroy(room, "creator_left");
      return { ok: false, closed: "creator_left" };
    }
    let expiredMember: Peer | undefined;
    for (const awayPeer of room.peers.values()) {
      if (
        awayPeer.peerId !== room.creatorPeerId &&
        awayPeer.socket === null &&
        awayPeer.awaySince !== null &&
        now - awayPeer.awaySince >= RECONNECT_GRACE_MS
      ) {
        expiredMember = awayPeer;
        break;
      }
    }
    if (expiredMember) {
      this.removePeer(room, expiredMember);
      this.afterMemberLoss(room, now, false);
      if (!this.rooms.has(roomId)) return { ok: false, closed: "peer_left" };
      return this.join(roomId, auth, peerId, ip, conn, requestedCap, requestedVanish);
    }
    let peer = room.peers.get(peerId);
    const reconnect = peer !== undefined;
    let wasAway = false;

    if (peer) {
      if (peer.socket && peer.socket !== conn) peer.socket.close();
      peer.socket = conn;
      wasAway = peer.awaySince !== null;
      peer.awaySince = null;
    } else {
      if (room.locked) return { ok: false, code: "room_locked" };
      if (room.peers.size >= room.cap) return { ok: false, code: "room_full" };
      const label = generateLabel(room.usedLabels);
      room.usedLabels.add(label);
      peer = {
        peerId,
        label,
        socket: conn,
        awaySince: null,
        rate: new TokenBucket(this.clock, MSG_RATE_PER_SECOND, MSG_RATE_BURST),
      };
      room.peers.set(peerId, peer);
    }

    const others = Array.from(room.peers.values()).filter((candidate) => candidate !== peer);
    const joined: JoinedFrame = {
      type: "joined",
      label: peer.label,
      members: others.map((member) => member.label),
      cap: room.cap,
      locked: room.locked,
      isCreator: peer.peerId === room.creatorPeerId,
      vanish: room.vanish,
    };
    conn.send(joined);

    for (const other of others) {
      if (other.socket) {
        const state = reconnect && wasAway ? "back" : "joined";
        other.socket.send({
          type: "peer",
          state,
          label: peer.label,
          count: connectedCount(room),
        });
      } else {
        conn.send({
          type: "peer",
          state: "away",
          label: other.label,
          count: connectedCount(room),
        });
      }
    }

    const present = connectedCount(room);
    if (present >= 2) room.hadMultipleConnected = true;
    room.singletonSince = room.hadMultipleConnected && present === 1 ? now : null;
    if (present >= 2) room.lastActivity = now;
    return { ok: true, label: peer.label };
  }

  msg(roomId: string, peerId: string, conn: Connection, frame: MsgFrame): void {
    const room = this.rooms.get(roomId);
    const peer = room?.peers.get(peerId);
    if (!room || !peer || peer.socket !== conn) return;
    if (frame.c.length > MAX_FRAME_BYTES) {
      conn.send({ type: "err", code: "too_large" });
      return;
    }
    const recipients = Array.from(room.peers.values()).filter(
      (member) => member !== peer && member.socket !== null,
    );
    if (!peer.rate.tryConsume() || !room.fanout.tryConsume(recipients.length)) {
      conn.send({ type: "err", code: "rate_limited" });
      return;
    }
    room.lastActivity = this.clock.now();

    for (const member of recipients) {
      member.socket!.send({ type: "msg", from: peer.label, c: frame.c });
    }
    if (recipients.length > 0) {
      conn.send({ type: "ack", n: frame.n });
    }
  }

  lock(roomId: string, peerId: string, conn: Connection): ErrorCode | null {
    const room = this.rooms.get(roomId);
    const peer = room?.peers.get(peerId);
    if (!room || !peer || peer.socket !== conn) return null;
    if (peer.peerId !== room.creatorPeerId) return "not_creator";
    if (!room.locked) {
      room.locked = true;
      for (const member of room.peers.values()) member.socket?.send({ type: "locked" });
    }
    return null;
  }

  leave(roomId: string, peerId: string, conn: Connection): void {
    const room = this.rooms.get(roomId);
    const peer = room?.peers.get(peerId);
    if (!room || !peer || peer.socket !== conn) return;
    if (peer.peerId === room.creatorPeerId) {
      this.destroy(room, "creator_left");
      return;
    }
    this.removePeer(room, peer);
    this.afterMemberLoss(room, this.clock.now(), true);
  }

  disconnect(roomId: string, peerId: string, conn: Connection): void {
    const room = this.rooms.get(roomId);
    const peer = room?.peers.get(peerId);
    if (!room || !peer || peer.socket !== conn) return;
    peer.socket = null;
    peer.awaySince = this.clock.now();
    const count = connectedCount(room);
    if (room.hadMultipleConnected && count === 1 && room.singletonSince === null) {
      room.singletonSince = this.clock.now();
    }
    this.broadcastPeer(room, "away", peer.label, count);
  }

  tick(): void {
    const now = this.clock.now();
    this.createLimiter.prune();

    for (const room of Array.from(this.rooms.values())) {
      if (now - room.createdAt >= MAX_ROOM_AGE_MS) {
        this.destroy(room, "expired");
        continue;
      }
      const creator = room.peers.get(room.creatorPeerId);
      if (
        creator &&
        creator.socket === null &&
        creator.awaySince !== null &&
        now - creator.awaySince >= CREATOR_GRACE_MS
      ) {
        this.destroy(room, "creator_left");
        continue;
      }
      let removedMember = false;
      for (const peer of Array.from(room.peers.values())) {
        if (
          peer.peerId !== room.creatorPeerId &&
          peer.socket === null &&
          peer.awaySince !== null &&
          now - peer.awaySince >= RECONNECT_GRACE_MS
        ) {
          this.removePeer(room, peer);
          removedMember = true;
        }
      }
      if (removedMember) this.afterMemberLoss(room, now, false);
      if (!this.rooms.has(room.id)) continue;

      if (
        room.singletonSince !== null &&
        now - room.singletonSince >= CREATOR_GRACE_MS &&
        connectedCount(room) === 1
      ) {
        this.destroy(room, "peer_left");
        continue;
      }
      if (
        connectedCount(room) < 2 &&
        !room.hadMultipleConnected &&
        now - room.createdAt >= WAITING_TIMEOUT_MS
      ) {
        this.destroy(room, "waiting_timeout");
        continue;
      }
      if (room.hadMultipleConnected && now - room.lastActivity >= IDLE_TIMEOUT_MS) {
        this.destroy(room, "idle");
      }
    }
  }

  private removePeer(room: Room, peer: Peer): void {
    room.peers.delete(peer.peerId);
    peer.socket?.close();
    peer.socket = null;
    this.broadcastPeer(room, "left", peer.label, connectedCount(room));
  }

  private afterMemberLoss(room: Room, now: number, explicitLeave: boolean): void {
    const count = connectedCount(room);
    if (room.hadMultipleConnected && count === 1) {
      // Explicit leave is immediate. Otherwise, allow disconnected members their
      // reconnect grace before deciding that only one person remains.
      const hasAwayPeer = Array.from(room.peers.values()).some((peer) => peer.socket === null);
      if (explicitLeave || !hasAwayPeer) {
        this.destroy(room, "peer_left");
        return;
      }
      room.singletonSince ??= now;
    } else if (count >= 2) {
      room.singletonSince = null;
    }
    if (room.peers.size === 0) this.rooms.delete(room.id);
  }

  private broadcastPeer(
    room: Room,
    state: "joined" | "left" | "away" | "back",
    label: string,
    count: number,
  ): void {
    for (const peer of room.peers.values()) {
      if (peer.socket) peer.socket.send({ type: "peer", state, label, count });
    }
  }

  private destroy(room: Room, reason: CloseReason): void {
    this.rooms.delete(room.id);
    this.deadRooms.set(room.id, { authHash: room.authHash, reason });
    while (this.deadRooms.size > this.maxDeadRooms) {
      const oldest = this.deadRooms.keys().next().value;
      if (oldest === undefined) break;
      this.deadRooms.delete(oldest);
    }
    for (const peer of room.peers.values()) {
      if (peer.socket) {
        peer.socket.send({ type: "closed", reason });
        peer.socket.close();
        peer.socket = null;
      }
      peer.awaySince = null;
    }
  }
}
