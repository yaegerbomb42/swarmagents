/**
 * Ambient types for the pinned @novnc/novnc client (v1.5.0 ships no .d.ts).
 * Only the surface the DesktopView uses is declared; everything else is
 * intentionally omitted. noVNC dispatches DOM CustomEvents with a `detail`.
 */
declare module "@novnc/novnc/lib/rfb" {
  export interface RfbCredentials {
    password?: string;
    username?: string;
    target?: string;
  }

  export interface RfbOptions {
    shared?: boolean;
    credentials?: RfbCredentials;
    wsProtocols?: string[];
  }

  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: RfbOptions);
    disconnect(): void;
    sendCredentials(creds: RfbCredentials): void;
    /** When true, all client input is disabled (read-only mirror). */
    viewOnly: boolean;
    /** Scale the framebuffer to fit the target element (16:9 fit). */
    scaleViewport: boolean;
    /** Ask the server to resize the guest desktop to the target size. */
    resizeSession: boolean;
    /** Keep the framebuffer at native size and clip to the element. */
    clipViewport: boolean;
    showDotCursor: boolean;
    focus(options?: { preventScroll?: boolean }): void;
    blur(): void;
    sendCtrlAltDel(): void;
    get capabilities(): Record<string, unknown>;
    addEventListener(type: string, listener: (ev: CustomEvent) => void): void;
    removeEventListener(type: string, listener: (ev: CustomEvent) => void): void;
  }
}
