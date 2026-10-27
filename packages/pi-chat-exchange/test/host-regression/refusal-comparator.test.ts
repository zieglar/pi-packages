import fs from "node:fs";
import { expect, it } from "vitest";

// Exercise the actual narrow.noWrite assertion body without launching Pi or
// touching a Store. This also detects recapture of the pre-operation evidence.
const source = fs.readFileSync(new URL("./real-host-recovery.test.ts", import.meta.url), "utf8");
const body = source.match(/check\("narrow\.noWrite"[^\n]*\(\) => \{([\s\S]*?)\n    \}\);/)?.[1];
if (!body) throw new Error("narrow.noWrite assertion body not found");
const compare = new Function("expect", "after", "narrowed", "captureAuthority", "state", body.replaceAll("state.paths!", "state.paths"));
const before = { messages: [{ idempotency_key: "original" }], auditEvents: [{ event_id: "original" }] };
function verify(after: typeof before) {
  let captures = 0;
  compare(expect, after, structuredClone(before), () => { captures++; return after; }, { paths: {} });
  return captures;
}
it("accepts genuinely unchanged full rows without recapturing evidence", () => {
  expect(verify(structuredClone(before)), "must never overwrite the saved pre-operation snapshot").toBe(0);
});
it("rejects an audit-only mutation", () => {
  expect(() => verify({ messages: before.messages, auditEvents: [{ event_id: "mutated" }] })).toThrow();
});
it("rejects a message mutation with a different idempotency key", () => {
  expect(() => verify({ messages: [{ idempotency_key: "different-key" }], auditEvents: before.auditEvents })).toThrow();
});
it("rejects an extra message written under an unrelated key", () => {
  expect(() => verify({ messages: [...before.messages, { idempotency_key: "unrelated-key" }], auditEvents: before.auditEvents })).toThrow();
});
