// Server-only browser runtime. Import from route handlers and tools; never from a client component.
export {
  BrowserSession,
  BrowserRuntime,
  browserRuntime,
  DEFAULT_LIMITS,
  keySlug,
  type BrowserEvent,
  type BrowserLimits,
  type BrowserPointer,
  type BrowserStatus,
  type ControlCommand,
  type ReplayEntry,
  type ScreencastFrame,
} from "./runtime";
export { dispatchInput, parseInput, type KeyInput, type MouseInput, type ViewerInput } from "./screencast";