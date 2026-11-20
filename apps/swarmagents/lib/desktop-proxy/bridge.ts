/**
 * DesktopBridge — splices the browser's WebSocket to the container's VNC web
 * client WebSocket, terminating the RFB handshake at both ends:
 *
 *   - toward the browser it plays the VNC server (security type "None"), so
 *     the browser never asks for or sends a password;
 *   - toward the container it plays the VNC client and answers the VNCAuth
 *     challenge with the driver-provided password — the server-side injection.
 *
 * The two streams are only spliced after both handshakes complete; from then
 * on bytes flow as WebSocket frames, with view-mode input filtering applied
 * on the browser->container direction.
 *
 * Framing: each direction has its own streaming WsFrameDecoder, so frames
 * split across TCP reads (a 200 KB framebuffer update arrives in many chunks)
 * and fragmented messages are reassembled before their payload is used. Raw
 * WebSocket bytes never mix with RFB payload bytes. Frames toward the browser
 * are unmasked (we are its server); frames toward the container are masked
 * (we are its client — websockify drops unmasked client frames with 1002).
 */

import net from "node:net";
import {
  RfbServerHandshake,
  RfbClientHandshake,
} from "./rfb";
import {
  RfbInputFilter,
  RfbProtocolError,
  type RfbFilterMode,
} from "./rfb-filter";
import {
  WsFrameDecoder,
  WsBufferOverflowError,
  WsMaskError,
  MAX_WS_BUFFER_BYTES,
  encodeFrame,
  encodeClientFrame,
  closeFrame,
  clientCloseFrame,
  OP_BINARY,
  OP_PING,
  OP_PONG,
  OP_CLOSE,
  type WsMessage,
} from "./ws";

export const HANDSHAKE_TIMEOUT_MS = 15_000;
/** WebSocket OP_PING keepalive interval once the streams are spliced. */
export const PING_INTERVAL_MS = 25_000;

/** Live bridge status, read from the bridge's own state. */
export interface DesktopBridgeStatus {
  /** The mode actually enforced right now (live filter state). */
  mode: RfbFilterMode;
  /** False once the bridge has failed or closed. */
  connected: boolean;
  /** True once both handshakes completed and the streams are spliced. */
  spliced: boolean;
}
const BROWSER_BACKPRESSURE_PAUSE_BYTES = 8 * 1024 * 1024;
const BROWSER_BACKPRESSURE_CLOSE_BYTES = 32 * 1024 * 1024;
const BROWSER_BACKPRESSURE_CLOSE_MS = 10_000;

export interface DesktopBridgeOptions {
  mode: RfbFilterMode;
  password: string;
  onActivity: () => void;
  onClose: (reason: string) => void;
  /**
   * Per-direction cap (bytes) on buffered-but-unprocessed data: the raw
   * WebSocket remainder plus fragments, and separately the pre-splice
   * deferred RFB payload. Exceeding it closes the bridge. Default 32 MB.
   */
  maxBufferBytes?: number;
  /** Bytes the browser sent after its upgrade request (http `head`). */
  clientHead?: Buffer;
  /** Bytes the container sent right after its 101 response (upgrade `head`). */
  upstreamHead?: Buffer;
  /** Override the WebSocket keepalive ping interval (ms). Default 25_000. */
  pingIntervalMs?: number;
}

export class DesktopBridge {
  private serverHs = new RfbServerHandshake();
  private clientHs: RfbClientHandshake;
  private filter: RfbInputFilter | null;
  private spliced = false;
  private closed = false;
  /** Raw WebSocket reassembly, browser -> proxy. */
  private readonly clientDecoder: WsFrameDecoder;
  /** Raw WebSocket reassembly, container -> proxy. */
  private readonly upstreamDecoder: WsFrameDecoder;
  private readonly maxBufferBytes: number;
  /** Decoded RFB payload from the client after its handshake finished, pre-splice. */
  private clientDeferred = Buffer.alloc(0);
  /** Decoded RFB payload from upstream after its handshake finished, pre-splice. */
  private upstreamDeferred = Buffer.alloc(0);
  private timeout: NodeJS.Timeout | null = null;
  private readonly onActivity: () => void;
  private readonly onCloseCb: (reason: string) => void;
  private upstreamPausedForBackpressure = false;
  private backpressureCloseTimer: NodeJS.Timeout | null = null;
  /** WebSocket keepalive: fires while spliced; cleared in fail(). */
  private pingTimer: NodeJS.Timeout | null = null;
  /** True after a ping was sent and no pong has arrived yet. */
  private awaitingPong = false;
  private readonly pingIntervalMs: number;

  constructor(
    private readonly client: net.Socket,
    private readonly upstream: net.Socket,
    options: DesktopBridgeOptions,
  ) {
    this.filter = options.mode === "view" ? new RfbInputFilter("view") : null;
    this.clientHs = new RfbClientHandshake(options.password);
    this.onActivity = options.onActivity;
    this.onCloseCb = options.onClose;
    this.maxBufferBytes = options.maxBufferBytes ?? MAX_WS_BUFFER_BYTES;
    this.pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
    // Browser frames (client->server) must be masked; upstream frames must not be.
    this.clientDecoder = new WsFrameDecoder(this.maxBufferBytes, true);
    this.upstreamDecoder = new WsFrameDecoder(this.maxBufferBytes, false);

    // The proxy is the RFB client toward the container: it speaks first.
    const startBytes = this.clientHs.start();
    if (startBytes.length > 0) this.writeUpstream(startBytes);

    client.on("data", (chunk: Buffer) => this.onClientChunk(chunk));
    upstream.on("data", (chunk: Buffer) => this.onUpstreamChunk(chunk));
    client.on("drain", () => this.onClientDrain());
    client.on("error", () => this.fail("client-error"));
    upstream.on("error", () => this.fail("upstream-error"));

    this.timeout = setTimeout(() => this.fail("handshake-timeout"), HANDSHAKE_TIMEOUT_MS);
    this.timeout.unref?.();

    // Keepalive: once spliced, a missed pong on two consecutive intervals
    // means a half-open TCP drop, so the bridge is failed rather than left
    // dangling. Started now (it no-ops until spliced) so a long handshake
    // cannot starve it.
    this.pingTimer = setInterval(() => this.sendKeepalivePing(), this.pingIntervalMs);
    this.pingTimer.unref?.();

    // Bytes that arrived alongside the upgrade go through the same decoders.
    if (options.upstreamHead && options.upstreamHead.length > 0) this.onUpstreamChunk(options.upstreamHead);
    if (options.clientHead && options.clientHead.length > 0) this.onClientChunk(options.clientHead);
  }

  /**
   * Switch the view/control filter on a live bridge. Called by
   * DesktopProxy.setUserMode so demoting a control session to view takes
   * effect immediately instead of waiting for a reconnect. Switching to
   * control drops the filter (a fresh one is created if demoted again, so
   * no partial filter state carries across a mode change).
   */
  setMode(mode: RfbFilterMode): void {
    if (this.closed) return;
    if (mode === "view" && !this.filter) {
      this.filter = new RfbInputFilter("view");
    } else if (mode === "control" && this.filter) {
      this.filter = null;
    }
  }

  /**
   * Live bridge status. `mode` is read from the filter actually installed
   * right now — the enforcement state — never from the mode requested at
   * construction, so a setMode that took effect is reflected here.
   */
  getStatus(): DesktopBridgeStatus {
    return {
      mode: this.filter ? "view" : "control",
      connected: !this.closed,
      spliced: this.spliced,
    };
  }

  /** One keepalive tick: fail on a missed pong, otherwise ping both peers. */
  private sendKeepalivePing(): void {
    if (this.closed || !this.spliced) return;
    if (this.awaitingPong) {
      this.fail("ping-timeout");
      return;
    }
    this.awaitingPong = true;
    try {
      if (!this.client.destroyed) this.writeClient(encodeFrame(OP_PING, Buffer.alloc(0)));
    } catch {}
    try {
      if (!this.upstream.destroyed) this.upstream.write(encodeClientFrame(OP_PING, Buffer.alloc(0)));
    } catch {}
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.backpressureCloseTimer) clearTimeout(this.backpressureCloseTimer);
    this.backpressureCloseTimer = null;
    this.client.destroy();
    this.upstream.destroy();
    this.onCloseCb(reason);
  }

  private failProtocol(code: number, reason: string): void {
    if (this.closed) return;
    // Best-effort close frames to both peers, then tear down.
    try {
      if (!this.client.destroyed) this.client.end(closeFrame(code, ""));
    } catch {}
    try {
      if (!this.upstream.destroyed) this.upstream.end(clientCloseFrame(code, ""));
    } catch {}
    this.fail(reason);
  }

  private handleMessage(message: WsMessage, fromClient: boolean): void {
    if (message.opcode === OP_PONG) {
      // A pong from either peer proves the connection is alive.
      this.awaitingPong = false;
      return;
    }
    if (message.opcode === OP_PING) {
      // Answer on the side that pinged; toward upstream we are the client, so
      // the pong is masked.
      if (fromClient) {
        this.writeClient(encodeFrame(OP_PONG, message.payload));
      } else if (!this.upstream.destroyed) {
        this.upstream.write(encodeClientFrame(OP_PONG, message.payload));
      }
      return;
    }
    if (message.opcode === OP_CLOSE) {
      const target = fromClient ? this.upstream : this.client;
      if (!target.destroyed) {
        target.write(fromClient ? clientCloseFrame(1000, "") : closeFrame(1000, ""));
        target.end();
      }
      this.fail("close-frame");
      return;
    }
    if (message.opcode !== OP_BINARY) return; // ignore text/unknown data
    if (fromClient) this.handleClientPayload(message.payload);
    else this.handleUpstreamPayload(message.payload);
  }

  private onClientChunk(chunk: Buffer): void {
    this.onChunk(chunk, true);
  }

  private onUpstreamChunk(chunk: Buffer): void {
    // Server->client frames are never masked; the decoder handles both, so
    // the same code path works for the upstream side.
    this.onChunk(chunk, false);
  }

  private onChunk(chunk: Buffer, fromClient: boolean): void {
    if (this.closed) return;
    const decoder = fromClient ? this.clientDecoder : this.upstreamDecoder;
    let messages: WsMessage[];
    try {
      messages = decoder.push(chunk);
    } catch (err) {
      const side = fromClient ? "client" : "upstream";
      if (err instanceof WsBufferOverflowError) {
        this.fail(`${side}-buffer-overflow`);
      } else if (err instanceof WsMaskError) {
        this.failProtocol(1002, `${side}-mask-violation`);
      } else {
        this.fail(fromClient ? "protocol-error" : "upstream-protocol-error");
      }
      return;
    }
    for (const message of messages) {
      if (this.closed) return;
      this.handleMessage(message, fromClient);
    }
    if (!this.closed) this.touch();
  }

  /** Append pre-splice RFB payload, enforcing the buffer cap. */
  private defer(fromClient: boolean, bytes: Buffer): void {
    if (fromClient) this.clientDeferred = Buffer.concat([this.clientDeferred, bytes]);
    else this.upstreamDeferred = Buffer.concat([this.upstreamDeferred, bytes]);
    const size = fromClient ? this.clientDeferred.length : this.upstreamDeferred.length;
    if (size > this.maxBufferBytes) this.fail(fromClient ? "client-buffer-overflow" : "upstream-buffer-overflow");
  }

  /** Browser payload bytes: drive the server handshake, then filter+splice. */
  private handleClientPayload(payload: Buffer): void {
    if (!this.serverHs.done) {
      try {
        const { out, surplus } = this.serverHs.feed(payload);
        if (out.length > 0) this.writeClient(encodeFrame(OP_BINARY, out));
        if (surplus.length > 0) this.defer(true, surplus);
      } catch {
        this.fail("client-handshake-error");
        return;
      }
      this.maybeSplice();
      return;
    }
    if (!this.spliced) {
      this.defer(true, payload);
      return;
    }
    this.forwardToUpstream(payload);
  }

  /** Upstream payload bytes: drive the client handshake (password injection). */
  private handleUpstreamPayload(payload: Buffer): void {
    if (!this.clientHs.done) {
      try {
        const { out, surplus } = this.clientHs.feed(payload);
        if (out.length > 0) this.writeUpstream(out);
        if (surplus.length > 0) this.defer(false, surplus);
      } catch {
        this.fail("upstream-handshake-error");
        return;
      }
      this.maybeSplice();
      return;
    }
    if (!this.spliced) {
      this.defer(false, payload);
      return;
    }
    this.writeClient(encodeFrame(OP_BINARY, payload));
  }

  private maybeSplice(): void {
    if (this.closed || this.spliced || !this.serverHs.done || !this.clientHs.done) return;
    this.spliced = true;
    if (this.timeout) clearTimeout(this.timeout);
    // The browser waits for ServerInit; send it with the upstream framebuffer
    // dimensions before any message bytes flow.
    const serverInit = this.serverHs.serverInit(this.clientHs.width, this.clientHs.height);
    this.writeClient(encodeFrame(OP_BINARY, serverInit));
    if (this.clientDeferred.length > 0) {
      const deferred = this.clientDeferred;
      this.clientDeferred = Buffer.alloc(0);
      this.forwardToUpstream(deferred);
    }
    if (this.upstreamDeferred.length > 0) {
      const deferred = this.upstreamDeferred;
      this.upstreamDeferred = Buffer.alloc(0);
      this.writeClient(encodeFrame(OP_BINARY, deferred));
    }
  }

  private forwardToUpstream(payload: Buffer): void {
    try {
      const out = this.filter ? this.filter.push(payload) : payload;
      if (out.length > 0) this.writeUpstream(out);
    } catch (err) {
      if (err instanceof RfbProtocolError) {
        // A view client sent an RFB message the filter cannot frame: fail
        // closed (1002) instead of letting it through unfiltered.
        this.failProtocol(1002, "rfb-view-violation");
      } else {
        this.fail("rfb-filter-error");
      }
    }
  }

  /** Toward the container the proxy is the WebSocket client: frames are masked. */
  private writeUpstream(payload: Buffer): void {
    if (!this.upstream.destroyed) this.upstream.write(encodeClientFrame(OP_BINARY, payload));
  }

  /** Write to the browser socket with backpressure handling. */
  private writeClient(data: Buffer): void {
    if (this.closed || this.client.destroyed) return;
    this.client.write(data);
    this.enforceBackpressure();
  }

  private enforceBackpressure(): void {
    if (this.closed) return;
    const queued = Number(this.client.writableLength ?? 0);
    if (!Number.isFinite(queued)) return;
    if (queued > BROWSER_BACKPRESSURE_PAUSE_BYTES) {
      if (!this.upstreamPausedForBackpressure && !this.upstream.destroyed && typeof this.upstream.pause === "function") {
        try {
          this.upstream.pause();
          this.upstreamPausedForBackpressure = true;
        } catch {}
      }
    }
    if (queued > BROWSER_BACKPRESSURE_CLOSE_BYTES) {
      if (!this.backpressureCloseTimer) {
        this.backpressureCloseTimer = setTimeout(() => {
          this.backpressureCloseTimer = null;
          if (this.closed || this.client.destroyed) return;
          const nowQueued = Number(this.client.writableLength ?? 0);
          if (Number.isFinite(nowQueued) && nowQueued > BROWSER_BACKPRESSURE_CLOSE_BYTES) {
            this.fail("client-backpressure-timeout");
          }
        }, BROWSER_BACKPRESSURE_CLOSE_MS);
        this.backpressureCloseTimer.unref?.();
      }
    } else if (this.backpressureCloseTimer) {
      clearTimeout(this.backpressureCloseTimer);
      this.backpressureCloseTimer = null;
    }
  }

  private onClientDrain(): void {
    if (this.closed) return;
    const queued = Number(this.client.writableLength ?? 0);
    if (!Number.isFinite(queued)) return;
    if (queued <= BROWSER_BACKPRESSURE_PAUSE_BYTES && this.upstreamPausedForBackpressure) {
      this.upstreamPausedForBackpressure = false;
      try {
        if (!this.upstream.destroyed && typeof this.upstream.resume === "function") this.upstream.resume();
      } catch {}
    }
    if (queued <= BROWSER_BACKPRESSURE_CLOSE_BYTES && this.backpressureCloseTimer) {
      clearTimeout(this.backpressureCloseTimer);
      this.backpressureCloseTimer = null;
    }
  }

  private touch(): void {
    this.onActivity();
  }
}
