import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MAX_FRAME_BYTES, parseClientFrame } from "@aside/protocol";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { type Clock, systemClock } from "./clock.js";
import { RoomManager, type Connection } from "./manager.js";

export interface AsideServer {
  manager: RoomManager;
  /** Start listening; resolves with the actual port (0 = ephemeral). */
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
}

/**
 * WebSocket relay over HTTP.
 *  - GET /healthz -> 200
 *  - WS  /ws/:roomId -> protocol connection
 * Zero logging: no request logs, no connection logs, no IPs, no user agents.
 */
export function createAsideServer(options: { clock?: Clock } = {}): AsideServer {
  const clock = options.clock ?? systemClock;
  const manager = new RoomManager({ clock });
  const wss = new WebSocketServer({ noServer: true });

  const httpServer: Server = createHttpServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(404);
    res.end();
  });

  httpServer.on("upgrade", (req, socket, head) => {
    const pathname = safePathname(req.url);
    if (pathname === null || !pathname.startsWith("/ws/") || pathname.length <= 4) {
      socket.destroy();
      return;
    }
    const roomId = pathname.slice("/ws/".length);
    wss.handleUpgrade(req, socket, head, (ws) => {
      attach(ws, roomId, req.socket.remoteAddress ?? "unknown");
    });
  });

  function attach(ws: WebSocket, roomId: string, ip: string): void {
    const conn: Connection = {
      send(frame) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(frame));
        }
      },
      close() {
        ws.close();
      },
    };
    let peerId: string | null = null;

    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        conn.send({ type: "err", code: "bad_format" });
        return;
      }
      const buffer = toBuffer(data);
      if (buffer.length > MAX_FRAME_BYTES) {
        conn.send({ type: "err", code: "too_large" });
        return;
      }
      const frame = parseClientFrame(buffer.toString("utf8"));
      if (!frame) {
        conn.send({ type: "err", code: "bad_format" });
        // A malformed pre-join frame cannot establish a room session.
        if (peerId === null) conn.close();
        return;
      }

      if (peerId === null) {
        if (frame.type !== "join") {
          conn.send({ type: "err", code: "bad_format" });
          conn.close();
          return;
        }
        const result = manager.join(
          roomId,
          frame.auth,
          frame.peerId,
          ip,
          conn,
          frame.cap,
          frame.vanish,
        );
        if (!result.ok) {
          if ("closed" in result) {
            // The link belongs to a room that already closed: report why, then
            // drop the socket so nothing can be re-created under this id.
            conn.send({ type: "closed", reason: result.closed });
            conn.close();
          } else {
            conn.send({ type: "err", code: result.code });
            if (result.code === "bad_cap" || result.code === "bad_format") conn.close();
          }
          return;
        }
        peerId = frame.peerId;
        return;
      }

      if (frame.type === "join") {
        conn.send({ type: "err", code: "bad_format" });
        return;
      }
      if (frame.type === "msg") {
        manager.msg(roomId, peerId, conn, frame);
      } else if (frame.type === "leave") {
        manager.leave(roomId, peerId, conn);
      } else if (frame.type === "lock") {
        const code = manager.lock(roomId, peerId, conn);
        if (code) conn.send({ type: "err", code });
      } else if (frame.type === "close") {
        conn.send({ type: "err", code: "bad_format" });
      } else {
        conn.send({ type: "err", code: "bad_format" });
      }
    });

    ws.on("close", () => {
      if (peerId !== null) {
        manager.disconnect(roomId, peerId, conn);
      }
    });
    ws.on("error", () => {
      // Deliberately silent: connection errors are never logged.
    });
  }

  const reaper = setInterval(() => manager.tick(), 10_000);

  return {
    manager,
    listen(port = 0): Promise<number> {
      return new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, () => {
          httpServer.removeListener("error", reject);
          resolve((httpServer.address() as AddressInfo).port);
        });
      });
    },
    async close(): Promise<void> {
      clearInterval(reaper);
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function safePathname(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url, "http://localhost").pathname;
  } catch {
    return null;
  }
}

function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  if (Buffer.isBuffer(data)) {
    return data;
  }
  return Buffer.from(data);
}
