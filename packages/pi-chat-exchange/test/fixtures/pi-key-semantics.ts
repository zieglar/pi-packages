import assert from "node:assert/strict";
import { piTunnelKeyProtocol as keys } from "../../pi-extension/tui-keys.js";
import { captureTunnelSecret, type SecureInputComponentView } from "../../src/tunnel/secure-input.js";

// Expectations characterized from Pi 1.3.0 keys.js, not from a replacement
// decoder or a mocked resolver. Exercise the seam through the real Host loader.
export default async function characterize(): Promise<void> {
  let assertions = 0;
  const check = (data: string, expected: string | undefined): void => {
    assert.equal(keys.decodePrintable(data), expected, JSON.stringify(data));
    assertions++;
  };
  for (let modifier = 1; modifier <= 256; modifier++) {
    const allowed = (((modifier - 1) & ~(1 | 64 | 128)) === 0);
    check(`\x1b[27;${modifier};65~`, allowed ? "A" : undefined);
    check(`\x1b[97:65;${modifier}u`, allowed ? ((modifier - 1) & 1 ? "A" : "a") : undefined);
  }
  for (const codepoint of [0, 9, 13, 27, 31, 32, 33, 126, 127, 128, 255, 0x1f600, 0x10ffff, 0x110000]) {
    const expected = codepoint >= 32 && codepoint <= 0x10ffff ? String.fromCodePoint(codepoint) : undefined;
    check(`\x1b[27;1;${codepoint}~`, expected);
  }
  for (const [data, expected] of [
    ["\x1b[97u", "a"], ["\x1b[97;1:1u", "a"],
    ["\x1b[97;1:2u", "a"], ["\x1b[97;1:3u", "a"],
    ["\x1b[97::65;2u", "a"], ["\x1b[97:65:97;2u", "A"],
    ["\x1b[27;0002;00065~", "A"],
    ["\x1b[27;0;65~", undefined], ["\x1b[27;1;31~", undefined],
    ["\x1b[27;1;999999999999999999999999~", undefined],
    ["\x1b[27;1;65~suffix", undefined], ["prefix\x1b[27;1;65~", undefined],
    ["\x1b[27;-1;65~", undefined], ["\x1b[27;1;65:3~", undefined],
    ["\x1b[27;1;65", undefined], ["\x1b[27;1;~", undefined],
    ["\x1b[1;1A", undefined], ["\x1b]52;c;payload\x07", undefined],
    ["\x00", undefined], ["plain", undefined], ["", undefined],
  ] as const) check(data, expected);

  assert.equal(keys.isKeyRelease("\x1b[97;1:3u"), true);
  assert.equal(keys.isKeyRelease("\x1b[97;1:2u"), false);
  assert.equal(keys.isKeyRelease("\x1b[200~:3u\x1b[201~"), false);
  for (const [data, key] of [["\x1b", keys.escape], ["\x03", keys.ctrlC], ["\x15", keys.ctrlU], ["\r", keys.enter], ["\x7f", keys.backspace]] as const) {
    assert.equal(keys.matches(data, key), true);
  }

  // Real secret-input consumer: releases/modifiers/control payloads cannot
  // become credential text, while both terminal encodings remain supported.
  async function capture(events: readonly string[]): Promise<string[]> {
    const stored: string[] = [];
    let component: SecureInputComponentView | undefined;
    const result = await captureTunnelSecret({ mode: "tui", ui: {
      custom: async (factory) => new Promise((resolve) => {
        component = factory({}, {}, {}, resolve);
        for (const event of events) component.handleInput?.(event);
        assert.ok(!component.render(100).join("\n").includes("AB:3u"));
        component.dispose?.();
      }),
    } }, { store: async (secret) => { stored.push(secret); } }, { keys });
    assert.ok(result.status === "stored" || result.status === "cancelled");
    return stored;
  }
  assert.deepEqual(await capture(["\x1b[27;2;65~", "\x1b[98:66;2u", "\x1b[99;1:3u", "\x1b[27;5;100~", "\x1b]52;c;payload\x07", ":3u", "\r"]), ["AB:3u"]);
  for (const denied of ["\x00", "\x1b[27;1;127~", "\x1b[27;1;128~", "\x1b[27;1;32~"]) {
    assert.deepEqual(await capture(["A", denied, "\r"]), []);
  }
  console.log(`Printable semantics PASS: ${assertions} decoder cases, 8 key/release checks, 5 secret-input flows`);
}
