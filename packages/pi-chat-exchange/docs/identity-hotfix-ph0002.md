[English](identity-hotfix-ph0002.md) | [简体中文](identity-hotfix-ph0002.zh-CN.md)

> Historical evidence or design record. Claims, commands, test results and limitations below describe the recorded phase, not current support or release eligibility.

# PH-0001 identity hotfix (authorized during PH-0002)

The PH-0001 assertion that `encodeUlid()` preserves all 80 random bits was
**disproved by a regression test**, not by a changed architecture requirement.

## Cause and bounded correction

The old loop emitted two five-bit characters from each byte (overlapping two
bits), indexed only bytes 0–7, and discarded bytes 8–9. Thus it preserved only
64 bits of random input and did not encode a canonical ULID randomness payload.
The corrected loop builds an 80-bit big-endian integer from all ten bytes and
emits sixteen non-overlapping five-bit groups. The 48-bit timestamp loop is
unchanged.

External contracts remain `ho_<26-character ULID>` and `hr_<26-character ULID>`;
Crockford alphabet, timestamp placement, ID length, prefix, non-secret opaque
identity, and validation APIs are unchanged. No existing identity is rewritten.
There is no persistent identity decoder in this package. `isHandoffId`,
`HandoffIdSchema` and `ResultIdSchema` validate format, not a truncated random
payload. The test-only timestamp decoder has no randomness assumption.
Existing validators remain unchanged (their broader format validation is not
expanded by this narrowly scoped fix).

## RED → GREEN evidence

Command: `mise x pnpm@12.9.1 -- pnpm --filter pi-handoff exec vitest run test/protocol/identity.test.ts`

Before the implementation fix: **4 failed, 7 passed**. The restored original
regression changed only random byte 9 from 0 to 1 at timestamp 0; both outputs
were `00000000000000000000000000`. Additional failures proved loss of individual
bits, wrong final-byte encoding, and failed independent 80-bit decode.

After the fix: **11 passed**. Coverage retains timestamp round trips and adds
all 80 single-bit inputs, first-byte and tenth-byte canonical vectors,
determinism, independent bigint decoding, alphabet/length and maximum timestamp
plus all-ones randomness (`7` + 25 `Z` characters).

Full package suite: **41 passed** (build performed before stdio test).
Typecheck, build, contract gate, workspace gate and diff whitespace check pass.
Wayforge regression: **438 passed / 51 files**, no Wayforge changes. Deliberate
negative architecture fixtures print expected violations; the suite exits 0.

Scratch raw logs: `/tmp/ph0002-hotfix-red.log`,
`/tmp/ph0002-hotfix-wayforge.log`. The original stop reproducer is
`/tmp/ph0002-stop/identity-repro.mjs` and is GREEN after this fix.

This independent hotfix contains only the encoder, identity regression/boundary
tests and this evidence note. PH-0002 architecture work resumes only after the
hotfix commit. No push or production integration.
