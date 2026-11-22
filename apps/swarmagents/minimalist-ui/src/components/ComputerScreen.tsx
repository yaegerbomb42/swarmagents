"use client";

/**
 * ComputerScreen — compatibility entry point.
 *
 * The computer used to live here: a Mac-dot titlebar, its own view switcher
 * and a `ComputerScreen` per view. Those three pieces are now one product
 * (`vm/VmScreen` → `vm/VmChrome`), so the old shell is gone and this module
 * keeps only the imports the rest of the app already uses. New code should
 * import from `./vm/VmScreen` directly.
 *
 * The stream-row renderer moved to `vm/streamRows.tsx`; it is re-exported here
 * because the humanized-terminal tests and a few callers import it from this
 * path.
 */

export { VmScreen as ComputerScreen, type VmScreenProps as ComputerScreenProps } from "./vm/VmScreen";
export type { ComputerView } from "./vm/VmChrome";
export {
  StreamRow,
  toolCallSummary,
  toolResultSummary,
} from "./vm/streamRows";

import { VmScreen } from "./vm/VmScreen";

export default VmScreen;
