"use client";

/**
 * ScreenView — the Screen tab's content (l4).
 *
 * The live desktop itself already exists — DesktopView dials the WS proxy
 * (lib/client/desktopConfig.ts) with the connection machine from
 * lib/client/desktopState.ts, and the ScreenFrame owns the status pill,
 * Take over / Hand back, fullscreen and the control banners. ScreenView is
 * the thin tab layer on top of that stack: it decides whether there is a
 * desktop to show at all, mounts the surface, and adds the two pieces the
 * tab was still missing:
 *
 *   - the unavailable empty state ("Desktop not available on this server")
 *     when the polled VM state says no desktop can appear, so the tab
 *     never dials into the void or throws;
 *   - a clipboard paste button: in control mode it reads the user's
 *     clipboard and hands the text to the VM through the RFB instance
 *     (`clipboardPasteFrom`, a no-op unless connected and not view-only).
 *     The RFB instance arrives through DesktopView's `onRfb` callback.
 *
 * The close-code contract lives in lib/client/useVmDisplay.ts. When a dial
 * is refused (offline without ever having been live — the proxy closed a
 * fresh dial), the mapped message for the refusal's most plausible code is
 * shown as a chip above the offline card.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ClipboardPaste, MonitorOff } from "lucide-react";
import type RFB from "@novnc/novnc/lib/rfb";
import { DesktopView, type DesktopConnectionInfo } from "./DesktopView";
import type { ComputerAction, Presence } from "../../../lib/client/presence";
import type { VmDisplayState } from "../../../lib/client/vmStatus";
import { refusalCloseCode, useVmDisplay } from "../../../lib/client/useVmDisplay";

export interface ScreenViewProps {
  /** The VM display state the ComputerScreen already computed for its pill. */
  vmState: VmDisplayState;
  /** True while a VM reset/wipe is in flight. */
  vmResetting?: boolean;
  /** True while an agent run is streaming (adds the takeover warning). */
  runActive?: boolean;
  /** Run to tag this viewer's session with, so its frames can be replayed. */
  runId?: string;
  /** The agent whose desktop this view shows (default "a1"). */
  agentId?: string;
  /** Stop the live agent run from the control-mode banner (optional). */
  onStopRun?: () => void;
  /** What the agent is doing right now (presence tint + action overlay). */
  presence?: Presence;
  /** The agent's latest computer-use action. */
  computerAction?: ComputerAction;
  /** Epoch ms of the newest watchdog.loop nudge; flashes the action chip. */
  loopNudgeAt?: number;
  /** Controlled interaction mode (the frame's Take over button owns it). */
  control?: boolean;
  onControlChange?: (control: boolean) => void;
  /** The frame's Take over button controls interaction; shown on the overlay. */
  canControl?: boolean;
  /** Detail from a vm.error event, for the booting overlay's error copy. */
  vmErrorMessage?: string;
  /** Reports connection phase/fps/latency changes to the frame pill. */
  onConnection?: (info: DesktopConnectionInfo) => void;
}

export function ScreenView({
  vmState,
  vmResetting = false,
  runActive = false,
  runId,
  agentId,
  onStopRun,
  presence,
  computerAction,
  loopNudgeAt,
  control,
  onControlChange,
  canControl = true,
  vmErrorMessage,
  onConnection,
}: ScreenViewProps) {
  const { available, unavailableMessage, describeClose } = useVmDisplay(vmState);
  const rfbRef = useRef<RFB | null>(null);
  const [conn, setConn] = useState<DesktopConnectionInfo | null>(null);
  // True once this mount has seen a live socket. A refusal (the proxy
  // closing a fresh dial) lands in "offline" without ever going live.
  const [everLive, setEverLive] = useState(false);
  const [pasteState, setPasteState] = useState<"idle" | "pasting" | "done" | "error">("idle");
  const [pasteError, setPasteError] = useState<string | undefined>(undefined);

  // A reset starts a fresh dial cycle: a refusal after it is a new refusal.
  useEffect(() => {
    if (vmState !== "ready") setEverLive(false);
  }, [vmState]);

  const handleConnection = useCallback(
    (info: DesktopConnectionInfo) => {
      setConn(info);
      if (info.phase === "live") setEverLive(true);
      onConnection?.(info);
    },
    [onConnection],
  );

  const handleRfb = useCallback((rfb: RFB | null) => {
    rfbRef.current = rfb;
  }, []);

  // Paste is only meaningful with a live socket the user actually controls:
  // noVNC's clipboardPasteFrom is a no-op in view-only mode or while
  // disconnected, so the button stays disabled until both hold.
  const canPaste = conn?.phase === "live" && conn?.takeover === "control";
  const onPaste = useCallback(async () => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    setPasteState("pasting");
    setPasteError(undefined);
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
        throw new Error("clipboard unavailable");
      }
      const text = await navigator.clipboard.readText();
      if (!text) {
        setPasteState("idle");
        return;
      }
      rfb.clipboardPasteFrom(text);
      setPasteState("done");
      window.setTimeout(() => setPasteState((s) => (s === "done" ? "idle" : s)), 2000);
    } catch {
      setPasteState("error");
      setPasteError("Clipboard read was blocked — allow clipboard access and try again.");
    }
  }, []);

  if (!available) {
    return (
      <div
        className="relative grid h-full w-full place-items-center bg-black"
        data-testid="screen-view-unavailable"
      >
        <div className="flex w-[min(420px,86%)] flex-col items-center gap-2 px-6 py-5 text-center">
          <MonitorOff className="h-5 w-5 text-white/40" aria-hidden />
          <div className="font-mono text-xs text-white/70">Desktop not available</div>
          <div className="font-mono text-[11px] leading-relaxed text-white/40">
            {unavailableMessage ?? "Desktop not available on this server"}
          </div>
        </div>
      </div>
    );
  }

  // Offline without ever having been live: the proxy refused the dial.
  // Say why, in the close code's words, above the offline card.
  const refused = conn?.phase === "offline" && !everLive;
  const refusalMessage = refused ? describeClose(refusalCloseCode(vmState)) : undefined;

  return (
    <div className="relative h-full w-full bg-black" data-testid="screen-view">
      <DesktopView
        vmState={vmState}
        vmResetting={vmResetting}
        runActive={runActive}
        runId={runId}
        agentId={agentId}
        onStopRun={onStopRun}
        presence={presence}
        computerAction={computerAction}
        loopNudgeAt={loopNudgeAt}
        embedded
        control={control}
        onControlChange={onControlChange}
        canControl={canControl}
        onConnection={handleConnection}
        onRfb={handleRfb}
        vmErrorMessage={vmErrorMessage}
      />

      {refusalMessage && (
        <div
          role="status"
          data-testid="screen-refusal-message"
          className="absolute inset-x-0 top-2 z-10 mx-auto w-fit max-w-[86%] rounded-full border border-amber-400/40 bg-amber-500/15 px-3 py-1 text-center font-mono text-[11px] text-amber-200"
        >
          {refusalMessage}
        </div>
      )}

      <div className="absolute bottom-2 right-2 z-10 flex items-center gap-2">
        {pasteState === "error" && pasteError && (
          <span
            role="alert"
            className="max-w-[260px] rounded-full border border-rose-400/40 bg-rose-500/15 px-2.5 py-1 font-mono text-[10px] text-rose-200"
          >
            {pasteError}
          </span>
        )}
        <button
          type="button"
          onClick={() => void onPaste()}
          disabled={!canPaste || pasteState === "pasting"}
          title={
            canPaste
              ? "Paste clipboard text into the VM"
              : "Take control of the desktop to paste clipboard text into it"
          }
          aria-label="Paste clipboard into the VM"
          data-testid="screen-paste-clipboard"
          className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-black/60 px-2.5 py-1 font-mono text-[11px] text-white/80 backdrop-blur transition-colors hover:bg-black/80 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ClipboardPaste className="h-3 w-3" aria-hidden />
          {pasteState === "done" ? "Pasted" : pasteState === "pasting" ? "Pasting…" : "Paste"}
        </button>
      </div>
    </div>
  );
}
