/**
 * xterm.js bundle entry: exposes Terminal + FitAddon on `window.Xterm` for the
 * plain-JS terminal controller (`media/terminal.js`), and pulls in the xterm
 * stylesheet so esbuild emits it as `out/xterm.css` (linked by chatView).
 * Typechecked by the webview tsconfig (DOM lib); excluded from the root one.
 */
import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

declare global {
  interface Window {
    Xterm: { Terminal: typeof Terminal; FitAddon: typeof FitAddon };
  }
}

window.Xterm = { Terminal, FitAddon };
