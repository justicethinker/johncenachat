import { useEffect, useRef, useState } from "react";
import {
  MAX_PEERS,
  MAX_TEXT_LENGTH,
  RECONNECT_GRACE_MS,
  decryptMessage,
  deriveKeys,
  encryptMessage,
  generateMessageId,
  generatePeerId,
  isValidRoomId,
  parseServerFrame,
  type CloseReason,
  type ErrorCode,
  type MessagePayload,
} from "@aside/protocol";

/**
 * Connection layer (spec section 8, step 5):
 *  - read the secret from the fragment, then strip it from the URL bar
 *  - derive keys, connect, join with an in-memory peerId
 *  - states: connecting | waiting | active | ended (+ incomplete link)
 *  - reconnect within the 30s grace window reusing the same peerId
 *  - received messages only; own messages are never stored or rendered
 */

export type RoomStatus = "incomplete" | "connecting" | "waiting" | "active" | "ended";
export type EndReason = CloseReason | ErrorCode | "reconnect_failed" | "left";

export interface ReceivedMessage {
  id: string;
  /** Server-stamped sender label (4 digits). */
  from: string;
  text: string;
  re?: string;
}

export interface RoomState {
  status: RoomStatus;
  label: string | null;
  peerLabel: string | null;
  peerPresent: boolean;
  members: Array<{ label: string; present: boolean }>;
  cap: number;
  isCreator: boolean;
  locked: boolean;
  vanish: boolean;
  endReason: EndReason | null;
  lastError: ErrorCode | null;
  messages: ReceivedMessage[];
  delivered: boolean;
}

export interface RoomApi extends RoomState {
  /** Encrypts and queues a message. Returns false when it cannot be sent. */
  sendMessage(text: string, re?: string): boolean;
  clearError(): void;
  /** Leave now: tells the server to destroy the room and shows the ended screen. */
  endChat(): void;
  /** Creator only: lock the room so no one else can join. One-way. */
  lock(): void;
  /** Ids of messages this tab has sent (kept in memory only, for replies). */
  sentIds: ReadonlySet<string>;
}

/** Shared ID-based deletion path for removal actions such as vanish-on-leave. */
export function removeMessagesByIds(
  messages: ReceivedMessage[],
  ids: ReadonlySet<string>,
): ReceivedMessage[] {
  if (ids.size === 0) return messages;
  return messages.filter((message) => !ids.has(message.id));
}

function parseVanish(search: string): boolean {
  return new URLSearchParams(search).get("vanish") !== "0";
}

const INITIAL_STATE: RoomState = {
  status: "connecting",
  label: null,
  peerLabel: null,
  peerPresent: false,
  members: [],
  cap: 8,
  isCreator: false,
  locked: false,
  vanish: true,
  endReason: null,
  lastError: null,
  messages: [],
  delivered: false,
};

/**
 * The creator's group size travels in the link query (`?cap=N`), not the
 * fragment, so the fragment stays the secret alone. Anything out of range is
 * dropped and the server default applies.
 */
function parseCap(search: string): number | null {
  const raw = new URLSearchParams(search).get("cap");
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const cap = Number(raw);
  return cap >= 2 && cap <= MAX_PEERS ? cap : null;
}

const CONNECT_TIMEOUT_MS = 10_000;
const RECONNECT_DELAY_MS = 1_000;
/** Stop reconnecting a little before the server's grace window closes. */
const RECONNECT_DEADLINE_MS = RECONNECT_GRACE_MS - 2_000;

export function useRoom(roomId: string): RoomApi {
  const [state, setState] = useState<RoomState>(INITIAL_STATE);

  const secretRef = useRef<{
    roomId: string;
    secret: string;
    cap: number | null;
    vanish: boolean;
  } | null>(null);
  const keysRef = useRef<{ encKey: CryptoKey; authToken: string } | null>(null);
  const peerIdRef = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const joinedRef = useRef(false);
  const msgCounterRef = useRef(0);
  const sendQueueRef = useRef<Promise<void>>(Promise.resolve());
  const sentIdsRef = useRef<Set<string>>(new Set());
  /** Assigned by the mounted room so the button can leave from outside the effect. */
  const endChatRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDeadline: number | null = null;
    let intentionalClose = false;
    const seenIds = new Set<string>();
    const vanishedLabels = new Set<string>();
    const vanishRef = { current: true };

    // Capture the secret exactly once per mounted room, then strip it from
    // the URL bar immediately: after this, it lives only in memory.
    if (secretRef.current === null || secretRef.current.roomId !== roomId) {
      const hash = window.location.hash;
      secretRef.current = {
        roomId,
        secret: hash.startsWith("#") ? hash.slice(1) : "",
        cap: parseCap(window.location.search),
        vanish: parseVanish(window.location.search),
      };
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    const secret = secretRef.current.secret;

    if (!secret || !isValidRoomId(roomId)) {
      setState({ ...INITIAL_STATE, status: "incomplete" });
      return;
    }

    void deriveKeys(secret)
      .then((keys) => {
        if (cancelled) return;
        keysRef.current = keys;
        peerIdRef.current = generatePeerId();
        connect();
      })
      .catch(() => {
        // Malformed secret: the link itself is broken.
        if (!cancelled) setState({ ...INITIAL_STATE, status: "incomplete" });
      });

    function clearConnectTimer(): void {
      if (connectTimer !== null) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
    }

    function connect(): void {
      if (cancelled) return;
      const keys = keysRef.current;
      const peerId = peerIdRef.current;
      if (!keys || !peerId) return;

      setState((s) => (s.status === "ended" ? s : { ...s, status: "connecting" }));
      msgCounterRef.current = 0;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      // Split hosting (Vercel/Railway frontend, relay elsewhere): a full
      // origin such as wss://relay.example.com. Unset means same-origin,
      // which is what local dev, Docker and the e2e suite use.
      const relayOrigin = import.meta.env.VITE_RELAY_WS as string | undefined;
      const socket = new WebSocket(
        relayOrigin
          ? `${relayOrigin.replace(/\/$/, "")}/ws/${roomId}`
          : `${protocol}//${window.location.host}/ws/${roomId}`,
      );
      wsRef.current = socket;

      connectTimer = setTimeout(() => {
        socket.close();
      }, CONNECT_TIMEOUT_MS);

      socket.onopen = () => {
        if (cancelled) {
          socket.close();
          return;
        }
        // `cap` is only honoured for the first joiner (the creator); the server
        // ignores it for everyone else, so every link can carry it safely.
        const cap = secretRef.current?.cap ?? undefined;
        const vanish = secretRef.current?.vanish ?? true;
        socket.send(JSON.stringify({ type: "join", auth: keys.authToken, peerId, cap, vanish }));
      };
      socket.onmessage = (event) => {
        void handleFrame(String(event.data));
      };
      socket.onclose = () => {
        handleClose();
      };
      socket.onerror = () => {
        // onclose always follows; nothing is ever logged.
      };
    }

    async function handleFrame(raw: string): Promise<void> {
      if (cancelled || intentionalClose) return;
      const frame = parseServerFrame(raw);
      if (!frame) return; // drop anything malformed

      switch (frame.type) {
        case "joined": {
          clearConnectTimer();
          joinedRef.current = true;
          reconnectDeadline = null;
          const members = frame.members.map((label) => ({ label, present: true }));
          const present = members.length > 0;
          vanishRef.current = frame.vanish;
          setState((s) => ({
            ...s,
            status: present ? "active" : "waiting",
            label: frame.label,
            peerLabel: members[0]?.label ?? null,
            peerPresent: present,
            members,
            cap: frame.cap,
            isCreator: frame.isCreator,
            locked: frame.locked,
            vanish: frame.vanish,
            endReason: null,
          }));
          return;
        }
        case "peer": {
          if (frame.state === "left" && vanishRef.current) {
            vanishedLabels.add(frame.label);
          }
          setState((s) => {
            if (s.status === "ended") return s;
            const existing = s.members.find((member) => member.label === frame.label);
            const members =
              frame.state === "left"
                ? s.members.filter((member) => member.label !== frame.label)
                : existing
                  ? s.members.map((member) =>
                      member.label === frame.label
                        ? { ...member, present: frame.state !== "away" }
                        : member,
                    )
                  : [...s.members, { label: frame.label, present: frame.state !== "away" }];
            const otherMembers = members.filter((member) => member.label !== s.label);
            const peerPresent = otherMembers.some((member) => member.present);
            const vanishedIds =
              s.vanish && frame.state === "left"
                ? new Set(
                    s.messages
                      .filter((message) => message.from === frame.label)
                      .map((message) => message.id),
                  )
                : new Set<string>();
            if (vanishedIds.size > 0) {
              for (const id of vanishedIds) seenIds.add(id);
            }
            return {
              ...s,
              status: peerPresent ? "active" : "waiting",
              peerPresent,
              peerLabel: otherMembers[0]?.label ?? null,
              members: otherMembers,
              messages: removeMessagesByIds(s.messages, vanishedIds),
            };
          });
          return;
        }
        case "locked": {
          setState((s) => ({ ...s, locked: true }));
          return;
        }
        case "msg": {
          const keys = keysRef.current;
          if (!keys) return;
          try {
            const payload = await decryptMessage(frame.c, keys.encKey, roomId);
            if (vanishedLabels.has(frame.from)) return;
            if (seenIds.has(payload.id)) return; // replay guard
            seenIds.add(payload.id);
            const message: ReceivedMessage =
              payload.re !== undefined
                ? { id: payload.id, from: frame.from, text: payload.text, re: payload.re }
                : { id: payload.id, from: frame.from, text: payload.text };
            setState((s) =>
              s.status === "ended" ? s : { ...s, messages: [...s.messages, message] },
            );
          } catch {
            // Undecryptable payload: drop it silently.
          }
          return;
        }
        case "ack": {
          setState((s) => ({ ...s, delivered: true }));
          return;
        }
        case "closed": {
          intentionalClose = true;
          joinedRef.current = false;
          clearConnectTimer();
          setState((s) => ({
            ...s,
            status: "ended",
            endReason: frame.reason,
            peerPresent: false,
          }));
          return;
        }
        case "err": {
          if (!joinedRef.current) {
            // A join-level error is terminal for this link.
            intentionalClose = true;
            clearConnectTimer();
            setState({ ...INITIAL_STATE, status: "ended", endReason: frame.code });
          } else {
            setState((s) => ({ ...s, lastError: frame.code }));
          }
          return;
        }
      }
    }

    function handleClose(): void {
      clearConnectTimer();
      wsRef.current = null;
      if (cancelled || intentionalClose) return;

      joinedRef.current = false;
      const now = Date.now();
      if (reconnectDeadline === null) {
        reconnectDeadline = now + RECONNECT_DEADLINE_MS;
      }
      if (now >= reconnectDeadline) {
        setState((s) => ({
          ...s,
          status: "ended",
          endReason: "reconnect_failed",
          peerPresent: false,
        }));
        return;
      }
      setState((s) =>
        s.status === "ended" ? s : { ...s, status: "connecting", peerPresent: false },
      );
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    }

    // Closing the tab or navigating away is an explicit exit: tell the
    // server so the room is destroyed immediately for the other person.
    const leaveOnce = (): void => {
      const socket = wsRef.current;
      if (joinedRef.current && socket && socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify({ type: "leave" }));
        } catch {
          // Socket already closing; the server reaps the room anyway.
        }
      }
    };
    window.addEventListener("beforeunload", leaveOnce);
    window.addEventListener("pagehide", leaveOnce);

    // Explicit "End chat": stop reconnecting, show the ended screen right
    // away, and tell the server to destroy the room for both people. The
    // server closes our socket after `leave`, so ignore anything after it.
    endChatRef.current = (): void => {
      if (cancelled) return;
      intentionalClose = true;
      joinedRef.current = false;
      clearConnectTimer();
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const socket = wsRef.current;
      wsRef.current = null;
      setState((s) =>
        s.status === "ended" ? s : { ...s, status: "ended", endReason: "left", peerPresent: false },
      );
      if (!socket) return;
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify({ type: "leave" }));
        } catch {
          // Socket already closing; the server reaps the room anyway.
        }
        // Fallback close in case the server never answers the leave.
        setTimeout(() => {
          try {
            socket.close();
          } catch {
            // Already closed.
          }
        }, 1_000);
      } else {
        try {
          socket.close();
        } catch {
          // Already closed.
        }
      }
    };

    return () => {
      cancelled = true;
      endChatRef.current = null;
      window.removeEventListener("beforeunload", leaveOnce);
      window.removeEventListener("pagehide", leaveOnce);
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      clearConnectTimer();
      const socket = wsRef.current;
      wsRef.current = null;
      if (socket) {
        // Leaving the screen means leaving the chat: destroy the room.
        // The server closes both sockets after `leave`, so we must not close
        // ours immediately — that can discard the frame before it flushes.
        if (joinedRef.current && socket.readyState === WebSocket.OPEN) {
          let sentLeave = false;
          try {
            socket.send(JSON.stringify({ type: "leave" }));
            sentLeave = true;
          } catch {
            // Socket may already be closing; the server will reap it.
          }
          if (sentLeave) {
            setTimeout(() => {
              try {
                socket.close();
              } catch {
                // Already closed by the server.
              }
            }, 1_000);
          } else {
            try {
              socket.close();
            } catch {
              // Already closed.
            }
          }
        } else {
          try {
            socket.close();
          } catch {
            // Already closed.
          }
        }
      }
      joinedRef.current = false;
    };
  }, [roomId]);

  function sendMessage(text: string, re?: string): boolean {
    const keys = keysRef.current;
    const socket = wsRef.current;
    if (!keys || !socket || socket.readyState !== WebSocket.OPEN || !joinedRef.current) {
      return false;
    }
    if (state.status !== "active") return false;
    if (text.length === 0 || text.length > MAX_TEXT_LENGTH) return false;

    setState((s) => ({ ...s, delivered: false }));
    const payload: MessagePayload =
      re !== undefined ? { id: generateMessageId(), text, re } : { id: generateMessageId(), text };

    // Queue sends so ciphertexts hit the wire in typing order.
    sendQueueRef.current = sendQueueRef.current.then(async () => {
      try {
        const c = await encryptMessage(payload, keys.encKey, roomId);
        if (socket.readyState !== WebSocket.OPEN) return;
        const n = msgCounterRef.current++;
        socket.send(JSON.stringify({ type: "msg", n, c }));
        sentIdsRef.current.add(payload.id);
      } catch {
        setState((s) => ({ ...s, lastError: "too_large" }));
      }
    });
    return true;
  }

  function lock(): void {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !joinedRef.current) return;
    // The server answers `locked` to everyone, or `err` with not_creator.
    try {
      socket.send(JSON.stringify({ type: "lock" }));
    } catch {
      // Socket closing; the room state will catch up on reconnect.
    }
  }

  function clearError(): void {
    setState((s) => (s.lastError === null ? s : { ...s, lastError: null }));
  }

  function endChat(): void {
    endChatRef.current?.();
  }

  return { ...state, sendMessage, clearError, endChat, lock, sentIds: sentIdsRef.current };
}
