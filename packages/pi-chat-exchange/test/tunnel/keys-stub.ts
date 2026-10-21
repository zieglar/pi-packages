import { Key, matchesKey } from "@earendil-works/pi-tui";
import { decodePrintableKey, isKeyRelease } from "@earendil-works/pi-tui/dist/keys.js";
import type { TunnelKeyProtocol } from "../../src/tunnel/secure-input.js";

/** Tests bind the same Pi key implementation the host injects in production. */
export const TEST_KEYS: TunnelKeyProtocol = Object.freeze({
  escape: Key.escape,
  ctrlC: Key.ctrl("c"),
  ctrlU: Key.ctrl("u"),
  enter: Key.enter,
  backspace: Key.backspace,
  matches: (data: string, key: string): boolean => matchesKey(data, key as never),
  decodePrintable: (data: string): string | undefined => decodePrintableKey(data),
  isKeyRelease: (data: string): boolean => isKeyRelease(data),
});
