'use client';

import { useEffect } from 'react';

/**
 * Tiny shared event bus for global overlays (command palette + shortcuts HUD).
 * Replaces synthetic `KeyboardEvent` dispatch as the way UI opens them.
 * Overlay components keep their own open state and subscribe here.
 */
export type OverlayName = 'omnibar' | 'shortcuts';
export type OverlayCommand = 'open' | 'close' | 'toggle';

type Listener = (cmd: OverlayCommand) => void;
const listeners: Record<OverlayName, Set<Listener>> = {
  omnibar: new Set(),
  shortcuts: new Set(),
};

export function requestOverlay(name: OverlayName, cmd: OverlayCommand = 'open') {
  listeners[name].forEach((l) => l(cmd));
}

export const openOmnibar = () => requestOverlay('omnibar', 'open');
export const toggleOmnibar = () => requestOverlay('omnibar', 'toggle');
export const openShortcuts = () => requestOverlay('shortcuts', 'open');
export const toggleShortcuts = () => requestOverlay('shortcuts', 'toggle');

export function onOverlayRequest(name: OverlayName, l: Listener) {
  listeners[name].add(l);
  return () => {
    listeners[name].delete(l);
  };
}

/** Wire a boolean setter to overlay requests. */
export function useOverlayRequests(
  name: OverlayName,
  setOpen: (updater: (prev: boolean) => boolean) => void,
) {
  useEffect(
    () =>
      onOverlayRequest(name, (cmd) =>
        setOpen((prev) => (cmd === 'toggle' ? !prev : cmd === 'open')),
      ),
    [name, setOpen],
  );
}
