/**
 * Single Pi key-protocol seam. The frozen contract gate
 * (`scripts/check-contract.mjs`) forbids `src/` from importing
 * `@earendil-works/*`, so the narrow key-decoding surface the secret input and
 * setup wizard need is provided here and injected into the transport-agnostic
 * domain. This is the only file coupled to the Pi runtime key implementation.
 */
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { decodePrintableKey, isKeyRelease } from "@earendil-works/pi-tui/dist/keys.js";
import type { TunnelKeyProtocol } from "../dist/tunnel/secure-input.js";

export const piTunnelKeyProtocol: TunnelKeyProtocol = Object.freeze({
  escape: Key.escape,
  ctrlC: Key.ctrl("c"),
  ctrlU: Key.ctrl("u"),
  enter: Key.enter,
  backspace: Key.backspace,
  matches: (data: string, key: string) => matchesKey(data, key as never),
  decodePrintable: (data: string) => decodePrintableKey(data),
  isKeyRelease: (data: string) => isKeyRelease(data),
});
