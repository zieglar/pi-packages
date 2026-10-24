/**
 * Single Pi key-protocol seam. The frozen contract gate
 * (`scripts/check-contract.mjs`) forbids `src/` from importing
 * `@earendil-works/*`, so the narrow key-decoding surface the secret input and
 * setup wizard need is provided here and injected into the transport-agnostic
 * domain. This is the only file coupled to the Pi runtime key implementation.
 */
import { decodeKittyPrintable, isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";
import type { TunnelKeyProtocol } from "../dist/tunnel/secure-input.js";

// Pi 1.3.0's loader aliases the package root to its index file, so deep
// imports are not loadable. Its public API exposes the Kitty decoder but not
// the combined printable decoder. Preserve the latter's modifyOtherKeys branch
// here: CSI 27;modifier;codepoint~, 1-indexed modifiers, Shift and lock bits
// only. Release filtering and visible-ASCII credential policy stay with the
// consumer, exactly as for the public Kitty decoder.
function decodeModifyOtherKeysPrintable(data: string): string | undefined {
  const match = data.match(/^\x1b\[27;(\d+);(\d+)~$/);
  if (!match) return undefined;
  const modifier = (Number.parseInt(match[1] ?? "", 10) - 1) & ~(64 | 128);
  if ((modifier & ~1) !== 0) return undefined;
  const codepoint = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(codepoint) || codepoint < 32) return undefined;
  try {
    return String.fromCodePoint(codepoint);
  } catch {
    return undefined;
  }
}

export const piTunnelKeyProtocol: TunnelKeyProtocol = Object.freeze({
  escape: Key.escape,
  ctrlC: Key.ctrl("c"),
  ctrlU: Key.ctrl("u"),
  enter: Key.enter,
  backspace: Key.backspace,
  matches: (data: string, key: string) => matchesKey(data, key as never),
  decodePrintable: (data: string) => decodeKittyPrintable(data) ?? decodeModifyOtherKeysPrintable(data),
  isKeyRelease: (data: string) => isKeyRelease(data),
});
