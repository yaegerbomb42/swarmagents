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
import { RfbServerDecoder, RfbServerUnsupportedError } from "./rfb-server";
import { FrameRecorder } from "./frame-recorder";
import { RfbInputObserver } from "./rfb-input-observer";
import type { InputEvent } from "./takeover/types";
import type { FrameTap } from "./frame-tap";
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
  /**
   * Opt-in framebuffer recording. When true with `recordingFile` set, the
   * bridge decodes the upstream server→client RFB stream and appends only
   * FramebufferUpdate messages (frames) to the recording file. Input and
   * control messages are never recorded. Default off: zero overhead and zero
   * files.
   */
  recordFrames?: boolean;
  /** Recording file path used when `recordFrames` is true. */
  recordingFile?: string;
  /**
   * Optional sink for decoded client->server input events (key/pointer/
   * clipboard), observed fail-open by RfbInputObserver. Used by the
   * takeover summarizer to count human input while driving. Observation
   * never alters the forwarded bytes and never throws across the bridge.
   */
  onInputEvent?: (event: InputEvent) => void;
  /**
   * Optional frame tap (damage-region differencing + keyframe capture).
   * Fed the same upstream server→client payloads as the recorder, plus the
   * pre-splice deferred bytes so its framebuffer shadow starts in sync.
   * The tap is fail-open by contract; if it ever throws anyway, the bridge
   * drops it and keeps streaming. Default: no tap, zero overhead.
   */
  frameTap?: FrameTap;
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
  private readonly frameDecoder: RfbServerDecoder | null;
  private readonly recorder: FrameRecorder | null;
  private readonly inputObserver: RfbInputObserver | null;
  private readonly onInputEvent?: (event: InputEvent) => void;
  /** Frame tap; nulled if it ever violates its never-throw contract. */
  private frameTap: FrameTap | null;

  // Bound so fail() can removeListener without leaking.
  private readonly onClientData = (chunk: Buffer) => this.onClientChunk(chunk);
  private readonly onUpstreamData = (chunk: Buffer) => this.onUpstreamChunk(chunk);
  private readonly onClientDrainBound = () => this.onClientDrain();
  private readonly onClientError = () => this.fail("client-error");
  private readonly onUpstreamError = () => this.fail("upstream-error");
  private readonly onClientEnd = () => this.fail("client-end");
  private readonly onClientClose = () => this.fail("client-close");
  private readonly onUpstreamEnd = () => this.fail("upstream-end");
  private readonly onUpstreamClose = () => this.fail("upstream-close");

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
    this.frameDecoder = options.recordFrames && options.recordingFile ? new RfbServerDecoder() : null;
    this.recorder = options.recordFrames && options.recordingFile ? new FrameRecorder(options.recordingFile) : null;
    this.inputObserver = options.onInputEvent ? new RfbInputObserver() : null;
    this.onInputEvent = options.onInputEvent;
    this.frameTap = options.frameTap ?? null;
    // Browser frames (client->server) must be masked; upstream frames must not be.
    this.clientDecoder = new WsFrameDecoder(this.maxBufferBytes, true);
    this.upstreamDecoder = new WsFrameDecoder(this.maxBufferBytes, false);

    // RFB is server-first (RFC 6143): toward the browser the proxy is the
    // server, so it sends its version string immediately — a real noVNC
    // client waits for it and sends nothing until it arrives. Toward the
    // container the proxy is the client and must wait for the container's
    // version string before replying, so clientHs.start() returns nothing
    // (the reply is emitted by feed() when the banner arrives). The 101
    // response has already been written by the proxy before construction,
    // so the version frame safely follows it on the wire.
    this.writeClient(encodeFrame(OP_BINARY, this.serverHs.start()));
    const startBytes = this.clientHs.start();
    if (startBytes.length > 0) this.writeUpstream(startBytes);

    client.on("data", this.onClientData);
    upstream.on("data", this.onUpstreamData);
    client.on("drain", this.onClientDrainBound);
    client.on("error", this.onClientError);
    upstream.on("error", this.onUpstreamError);
    // Detect half-open / peer-gone without waiting for the next ping.
    client.on("end", this.onClientEnd);
    client.on("close", this.onClientClose);
    upstream.on("end", this.onUpstreamEnd);
    upstream.on("close", this.onUpstreamClose);

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

  /**
   * The frame tap attached to this bridge, if any. The proxy's keyframe
   * read API and the handback summarizer's latest-frame lookup go through
   * here. Null when no tap was configured or it was dropped after throwing.
   */
  getFrameTap(): FrameTap | null {
    return this.frameTap;
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

  private detachSocketListeners(): void {
    this.client.removeListener("data", this.onClientData);
    this.client.removeListener("drain", this.onClientDrainBound);
    this.client.removeListener("error", this.onClientError);
    this.client.removeListener("end", this.onClientEnd);
    this.client.removeListener("close", this.onClientClose);
    this.upstream.removeListener("data", this.onUpstreamData);
    this.upstream.removeListener("error", this.onUpstreamError);
    this.upstream.removeListener("end", this.onUpstreamEnd);
    this.upstream.removeListener("close", this.onUpstreamClose);
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
    this.detachSocketListeners();
    this.recorder?.close();
    try {
      this.frameTap?.close();
    } catch {
      // tap teardown must never block bridge teardown
    }
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
    this.recordFrames(payload);
    this.writeClient(encodeFrame(OP_BINARY, payload));
    // Tap after forwarding: the live path is never delayed by tap work.
    this.feedFrameTap(payload);
  }

  /**
   * Feed the upstream payload to the frame tap. The tap's contract is
   * never-throw (it disables itself on bad input); if an implementation
   * violates that anyway, drop the tap — the stream must not notice.
   */
  private feedFrameTap(payload: Buffer): void {
    if (!this.frameTap) return;
    try {
      this.frameTap.feed(payload);
    } catch {
      this.frameTap = null;
    }
  }

  /**
   * Feed the upstream server→client payload to the frame decoder and append
   * only FramebufferUpdate messages to the recorder. If encoding hits a
   * message/encoding it cannot size, recording stops cleanly (a terminal note
   * is written) and the live forward path is unaffected — recording never
   * crashes the bridge.
   */
  private recordFrames(payload: Buffer): void {
    if (!this.frameDecoder || !this.recorder || !this.recorder.active) return;
    try {
      for (const frame of this.frameDecoder.push(payload)) {
        if (frame.type === 0) this.recorder.append(frame.raw);
      }
    } catch (err) {
      if (err instanceof RfbServerUnsupportedError) {
        this.recorder.close();
      } else {
        this.fail("rfb-recording-error");
      }
    }
  }

  private maybeSplice(): void {
    if (this.closed || this.spliced || !this.serverHs.done || !this.clientHs.done) return;
    this.spliced = true;
    if (this.timeout) clearTimeout(this.timeout);
    // The browser waits for ServerInit; send it with the upstream framebuffer
    // dimensions before any message bytes flow.
    const serverInit = this.serverHs.serverInit(this.clientHs.width, this.clientHs.height);
    this.writeClient(encodeFrame(OP_BINARY, serverInit));
    // The tap sizes its framebuffer shadow from the upstream ServerInit and
    // receives the deferred upstream bytes below, so its compositor starts
    // at a message boundary (the recorder does not get the deferred bytes —
    // a pre-existing gap this does not change).
    if (this.frameTap) {
      try {
        this.frameTap.setFramebufferSize(this.clientHs.width, this.clientHs.height);
      } catch {
        this.frameTap = null;
      }
    }
    if (this.clientDeferred.length > 0) {
      const deferred = this.clientDeferred;
      this.clientDeferred = Buffer.alloc(0);
      this.forwardToUpstream(deferred);
    }
    if (this.upstreamDeferred.length > 0) {
      const deferred = this.upstreamDeferred;
      this.upstreamDeferred = Buffer.alloc(0);
      this.feedFrameTap(deferred);
      this.writeClient(encodeFrame(OP_BINARY, deferred));
    }
  }

  private forwardToUpstream(payload: Buffer): void {
    // Observe (never alter) client input for the takeover summarizer. The
    // observer is fail-open and the sink is guarded: neither may break the
    // stream, in view mode or control mode.
    if (this.inputObserver && this.onInputEvent) {
      for (const event of this.inputObserver.observe(payload)) {
        try {
          this.onInputEvent(event);
        } catch {
          /* observer sink must not break the stream */
        }
      }
    }
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
