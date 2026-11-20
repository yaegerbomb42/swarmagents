/**
 * Desktop endpoint for BYOC nodes.
 *
 * The app's desktop proxy (lib/desktop-proxy) knows how to serve a user's
 * desktop: it terminates RFB toward the browser and speaks VNC toward an
 * upstream it reaches over TCP. For a BYOC node the upstream is not
 * reachable by address — the node is behind the user's NAT and only the
 * outbound tunnel exists.
 *
 * So this module runs a tiny local WebSocket server (one per user) that the
 * desktop proxy can dial exactly like a container's noVNC endpoint. Bytes
 * are relayed verbatim:
 *
 *   browser <-RFB- proxy <- local endpoint <- tunnel -> node -> noVNC -> VNC
 *
 * The local endpoint performs the WebSocket handshake with the proxy and
 * then does nothing but copy bytes, so the RFB handshake, the password
 * injection and the view-only filtering all stay in the desktop proxy.
 */

import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { URL } from "node:url";
import {
  MAX_WS_BUFFER_BYTES,
  OP_BINARY,
  OP_CLOSE,
  OP_PING,
  OP_PONG,
  WsFrameDecoder,
  encodeFrame,
} from "../desktop-proxy/ws";
import type { ByocDesktopChannel, ByocHub } from "./hub";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Path the desktop proxy dials on this endpoint. */
export const BYOC_DESKTOP_WS_PATH = "/websockify";

/** A local endpoint serving one user's desktop. */
export interface ByocDesktopEndpoint {
  /** Host the desktop proxy should dial (always loopback). */
  host: string;
  /** Port the desktop proxy should dial. */
  port: number;
  /** Close the endpoint (and its listener). */
  close: () => void;
}

export interface ByocDesktopEndpointOptions {
  hub: ByocHub;
  /** Interface to bind (default 127.0.0.1 — never reachable from outside). */
  host?: string;
  /** The device whose desktop this endpoint serves. */
  deviceId: string;
  /** The account whose sandbox desktop is shown. */
  userId: string;
}

/** RFC 6455 accept key. */
function acceptKey(key: string): string {
  return crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
}

/**
 * Open a loopback WebSocket endpoint that fronts a node's desktop stream.
 *
 * The endpoint is created on demand (one per user) and torn down when the
 * node goes away or the caller closes it.
 */
export async function openByocDesktopEndpoint(
  opts: ByocDesktopEndpointOptions,
): Promise<ByocDesktopEndpoint> {
  const host = opts.host ?? "127.0.0.1";
  const server = http.createServer();

  const close = () => {
    try {
      server.close();
    } catch {
      /* ignore */
    }
  };

  const handleUpgrade = async (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== BYOC_DESKTOP_WS_PATH) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.end();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string" || key.length === 0) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.end();
      return;
    }

    let channel: ByocDesktopChannel;
    try {
      channel = await opts.hub.openDesktop(opts.deviceId, opts.userId);
    } catch {
      socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      socket.end();
      return;
    }

    socket.setNoDelay(true);
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );

    // The desktop proxy is the websocket client here, so its frames arrive
    // masked and ours must be unmasked. Only the RFB payload travels through
    // the tunnel — each side frames it for its own websocket peer.
    const decoder = new WsFrameDecoder(MAX_WS_BUFFER_BYTES, true);

    // Node -> browser: wrap the RFB payload in a websocket frame.
    channel.on("data", (payload: Buffer) => {
      if (socket.destroyed) return;
      socket.write(encodeFrame(OP_BINARY, payload));
    });
    const onChannelClose = () => {
      if (!socket.destroyed) socket.end();
    };
    channel.on("close", onChannelClose);

    // Browser -> node: unwrap the websocket frames and hand the RFB payload
    // to the hub, which frames it for the tunnel.
    socket.on("data", (chunk: Buffer) => {
      let messages;
      try {
        messages = decoder.push(chunk);
      } catch {
        opts.hub.closeDesktop(channel.channelId);
        return;
      }
      for (const message of messages) {
        if (message.opcode === OP_BINARY) {
          opts.hub.writeDesktop(channel.channelId, message.payload);
        } else if (message.opcode === OP_PING) {
          if (!socket.destroyed) socket.write(encodeFrame(OP_PONG, message.payload));
        } else if (message.opcode === OP_CLOSE) {
          opts.hub.closeDesktop(channel.channelId);
          return;
        }
      }
    });
    socket.on("error", () => {
      opts.hub.closeDesktop(channel.channelId);
    });
    socket.on("close", () => {
      opts.hub.closeDesktop(channel.channelId);
    });

    if (head && head.length > 0) {
      try {
        for (const message of decoder.push(head)) {
          if (message.opcode === OP_BINARY) {
            opts.hub.writeDesktop(channel.channelId, message.payload);
          }
        }
      } catch {
        /* the proxy will notice the broken stream */
      }
    }
  };

  server.on("upgrade", (req, socket, head) => {
    handleUpgrade(req, socket as net.Socket, head).catch(() => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const port = addr && typeof addr === "object" ? addr.port : 0;
  return { host, port, close };
}
