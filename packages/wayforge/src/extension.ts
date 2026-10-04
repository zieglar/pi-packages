import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * Inert Wayforge extension entry point for Phase 1A.
 *
 * It intentionally registers nothing: no workflow command, no retry behavior,
 * no continuation, no worker, no advisor. The compatibility adapter and ports
 * are constructed elsewhere against real `ExtensionAPI`/`ExtensionContext`
 * objects; wiring them into Pi commands is Phase 1B work.
 */
export const wayforgeExtension: ExtensionFactory = (_pi) => {
  /* inert by design */
};
