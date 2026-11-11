/**
 * Wildcard declaration for side-effect CSS imports in the webview bundle
 * (xterm-shim.ts imports the xterm stylesheet so esbuild emits out/xterm.css).
 */
declare module '*.css';
