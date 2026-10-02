import { useEffect, useRef, useState } from "react";
import {
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
export type EndReason = CloseReason | ErrorCode | "reconnect_failed";

export interface ReceivedMessage {
  id: string;
  text: string;
  re?: string;
}

export interface RoomState {
  status: RoomStatus;
  label: string | null;
  peerLabel: string | null;
  peerPresent: boolean;
  endReason: EndReason | null;
  lastError: ErrorCode | null;
  messages: ReceivedMessage[];
  delivered: boolean;
}

export interface RoomApi extends RoomState {
  /** Encrypts and queues a message. Returns false when it cannot be sent. */
  sendMessage(text: string, re?: string): boolean;
  clearError(): void;
  /** Ids of messages this tab has sent (kept in memory only, for replies). */
  sentIds: ReadonlySet<string>;
}

const INITIAL_STATE: RoomState = {
  status: "connecting",
  label: null,
  peerLabel: null,
  peerPresent: false,
  endReason: null,
  lastError: null,
  messages: [],
  delivered: false,
};

const CONNECT_TIMEOUT_MS = 10_000;
const RECONNECT_DELAY_MS = 1_000;
/** Stop reconnecting a little before the server's grace window closes. */
const RECONNECT_DEADLINE_MS = RECONNECT_GRACE_MS - 2_000;

export function useRoom(roomId: string): RoomApi {
  const [state, setState] = useState<RoomState>(INITIAL_STATE);

  const secretRef = useRef<{ roomId: string; secret: string } | null>(null);
  const keysRef = useRef<{ encKey: CryptoKey; authToken: string } | null>(null);
  const peerIdRef = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const joinedRef = useRef(false);
  const msgCounterRef = useRef(0);
  const sendQueueRef = useRef<Promise<void>>(Promise.resolve());
  const sentIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDeadline: number | null = null;
    let intentionalClose = false;
    const seenIds = new Set<string>();

    // Capture the secret exactly once per mounted room, then strip it from
    // the URL bar immediately: after this, it lives only in memory.
    if (secretRef.current === null || secretRef.current.roomId !== roomId) {
      const hash = window.location.hash;
      secretRef.current = { roomId, secret: hash.startsWith("#") ? hash.slice(1) : "" };
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
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws/${roomId}`);
      wsRef.current = socket;

      connectTimer = setTimeout(() => {
        socket.close();
      }, CONNECT_TIMEOUT_MS);

      socket.onopen = () => {
        if (cancelled) {
          socket.close();
          return;
        }
        socket.send(JSON.stringify({ type: "join", auth: keys.authToken, peerId }));
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
          const present = frame.peers === 2;
          setState((s) => ({
            ...s,
            status: present ? "active" : "waiting",
            label: frame.label,
            peerLabel: frame.peerLabel ?? s.peerLabel,
            peerPresent: present,
            endReason: null,
          }));
          return;
        }
        case "peer": {
          const present = frame.state !== "away";
          setState((s) =>
            s.status === "ended"
              ? s
              : {
                  ...s,
                  status: present ? "active" : "waiting",
                  peerPresent: present,
                  peerLabel: frame.peerLabel ?? s.peerLabel,
                },
          );
          return;
        }
        case "msg": {
          const keys = keysRef.current;
          if (!keys) return;
          try {
            const payload = await decryptMessage(frame.c, keys.encKey, roomId);
            if (seenIds.has(payload.id)) return; // replay guard
            seenIds.add(payload.id);
            setState((s) =>
              s.status === "ended"
                ? s
                : {
                    ...s,
                    messages: [
                      ...s.messages,
                      payload.re !== undefined
                        ? { id: payload.id, text: payload.text, re: payload.re }
                        : { id: payload.id, text: payload.text },
                    ],
                  },
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

    return () => {
      cancelled = true;
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

  function clearError(): void {
    setState((s) => (s.lastError === null ? s : { ...s, lastError: null }));
  }

  return { ...state, sendMessage, clearError, sentIds: sentIdsRef.current };
}
