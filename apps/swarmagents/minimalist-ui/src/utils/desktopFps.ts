/**
 * desktopFps.ts — best-effort frames-per-second meter for the live desktop
 * view.
 *
 * noVNC 1.5 has no public per-frame event, so we wrap the pinned RFB class's
 * internal framebuffer-update handler and count it per second. The wrap is
 * installed once on the prototype (there is one desktop view at a time) and
 * removed on stop; if a future noVNC version renames the handler the meter
 * degrades to reporting 0 fps rather than breaking the connection.
 */

import RFB from "@novnc/novnc/lib/rfb";

type Patchable = { _framebufferUpdate?: (...args: unknown[]) => unknown };

let frames = 0;
let wrapped: Patchable | null = null;

function installWrap(): void {
  if (wrapped) return;
  const proto = (RFB as unknown as { prototype: Patchable }).prototype;
  const prev = proto._framebufferUpdate;
  if (typeof prev !== "function") return; // noVNC changed shape: degrade quietly
  const counter = function (this: unknown, ...args: unknown[]) {
    frames += 1;
    return prev.call(this, ...args);
  };
  proto._framebufferUpdate = counter;
  wrapped = { _framebufferUpdate: prev };
}

function removeWrap(): void {
  if (!wrapped) return;
  const proto = (RFB as unknown as { prototype: Patchable }).prototype;
  // Only restore if nothing else has replaced our wrapper meanwhile.
  const current = proto._framebufferUpdate;
  if (wrapped._framebufferUpdate !== undefined && current !== undefined) {
    proto._framebufferUpdate = wrapped._framebufferUpdate;
  }
  wrapped = null;
}

export class DesktopFpsMeter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private listener: ((fps: number) => void) | null = null;
  private current = 0;

  start(listener: (fps: number) => void): void {
    this.stop();
    installWrap();
    frames = 0;
    this.listener = listener;
    this.timer = setInterval(() => {
      this.current = frames;
      frames = 0;
      listener(this.current);
    }, 1_000);
  }

  stop(): void {
    this.listener = null;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    removeWrap();
  }

  get fps(): number {
    return this.current;
  }
}
