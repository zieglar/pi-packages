import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { canonicalDigest } from "../../src/protocol/idempotency.js";
import {
  normalizeCreateExchangeRequest, normalizeCreateMessageRequest,
  CreationRequestError, MAX_CREATION_PAYLOAD_BYTES,
} from "../../src/storage/creation-request.js";

const exchangeId = "ho_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const endpoint = { adapter: "pi", endpointId: "conversation" };
const exchangeRequest = () => ({ namespace: "owner", idempotencyKey: "key" });
const messageRequest = (payload: unknown = new Uint8Array([1, 2, 3])) => ({
  exchangeId, from: { ...endpoint }, to: { adapter: "other", endpointId: "destination" },
  payload, idempotencyKey: "key",
});
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function invalid(action: () => unknown) {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(CreationRequestError);
    expect(error).toMatchObject({ code: "STORAGE_CREATE_REQUEST_INVALID", retryable: false });
    expect((error as Error).cause).toBeUndefined();
    return error as Error;
  }
  throw new Error("request unexpectedly accepted");
}

it("normalizes Exchange namespace and exact frozen digest without caller mutation", () => {
  const input = Object.freeze(exchangeRequest());
  const result = normalizeCreateExchangeRequest(input);
  expect(result).toEqual({ namespace: '["exchange.create","owner"]', idempotencyKey: "key",
    requestDigest: canonicalDigest({ op: "chat-exchange/exchange.create", v: 1 }) });
  expect(Object.isFrozen(result)).toBe(true);
  expect(input).toEqual(exchangeRequest());
});

it("preserves well-formed Unicode and byte-exact namespace/key spelling", () => {
  const request = { namespace: "owner-😀", idempotencyKey: " é " };
  const normalized = normalizeCreateExchangeRequest(request);
  expect(normalized.namespace).toBe(JSON.stringify(["exchange.create", request.namespace]));
  expect(normalized.idempotencyKey).toBe(request.idempotencyKey);
  expect(normalizeCreateExchangeRequest({ namespace: "n".repeat(256), idempotencyKey: "k".repeat(256) }).idempotencyKey).toHaveLength(256);
});

it("captures Exchange accessors exactly once", () => {
  let namespaceCalls = 0, keyCalls = 0;
  const input = {
    get namespace() { namespaceCalls++; return "owner"; },
    get idempotencyKey() { keyCalls++; return "key"; },
  };
  normalizeCreateExchangeRequest(input);
  expect([namespaceCalls, keyCalls]).toEqual([1, 1]);
});

it("V3: an empty body has its actual byte length and empty SHA-256 digest", () => {
  const result = normalizeCreateMessageRequest(messageRequest(new Uint8Array()));
  expect(result.payloadLength).toBe(0);
  expect(result.payloadDigest).toBe(sha256(new Uint8Array()));
  expect(result.namespace).toBe(JSON.stringify(["message.create", exchangeId]));
});

it("V4: captures explicit endpoints, omits absent instanceId, and uses canonicalDigest parity", () => {
  const input = messageRequest();
  const result = normalizeCreateMessageRequest(input);
  expect(result.from).toEqual(endpoint);
  expect(Object.hasOwn(result.from, "instanceId")).toBe(false);
  expect(result.fromEndpointJson).toBe(JSON.stringify(endpoint));
  expect(result.toEndpointJson).toBe(JSON.stringify(input.to));
  expect(result.requestDigest).toBe(canonicalDigest({
    op: "chat-exchange/message.create", v: 1, exchangeId, from: result.from, to: result.to,
    payloadDigest: sha256(new Uint8Array([1, 2, 3])), payloadLength: 3,
  }));
  const reordered = { ...input, from: { endpointId: "conversation", adapter: "pi" } };
  expect(normalizeCreateMessageRequest(reordered).requestDigest).toBe(result.requestDigest);
  const withInstance = normalizeCreateMessageRequest({ ...input, from: { ...endpoint, instanceId: "incarnation" } });
  expect(JSON.parse(withInstance.fromEndpointJson)).toEqual({ ...endpoint, instanceId: "incarnation" });
  expect(withInstance.requestDigest).not.toBe(result.requestDigest);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.from)).toBe(true);
  expect(Object.isFrozen(result.to)).toBe(true);
  expect(result.from).not.toBe(input.from);
});

it("captures all caller-controlled request and endpoint getters exactly once", () => {
  const input = messageRequest();
  const calls: Record<string, number> = {};
  const captured: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    Object.defineProperty(captured, key, { enumerable: true, configurable: true, get() { calls[key] = (calls[key] ?? 0) + 1; return key === "from" ? from : value; } });
  }
  const from: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(endpoint)) {
    Object.defineProperty(from, key, { enumerable: true, get() { calls[`from.${key}`] = (calls[`from.${key}`] ?? 0) + 1; return value; } });
  }
  const result = normalizeCreateMessageRequest(captured);
  expect(result.from).toEqual(endpoint);
  expect(Object.values(calls).every((n) => n === 1)).toBe(true);
  expect(calls["from.adapter"]).toBe(1);
  expect(calls["from.endpointId"]).toBe(1);
});

it.each([null, undefined, [], "request", 42, new Date(), Object.create({ namespace: "n", idempotencyKey: "k" })])(
  "I1: rejects malformed top-level Exchange request %#", (input) => { invalid(() => normalizeCreateExchangeRequest(input)); },
);

it.each([
  {}, { namespace: "n" }, { ...exchangeRequest(), extra: true },
  { namespace: "", idempotencyKey: "k" }, { namespace: "n".repeat(257), idempotencyKey: "k" },
  { namespace: "n\u0000", idempotencyKey: "k" }, { namespace: "\ud800", idempotencyKey: "k" },
  { namespace: "n", idempotencyKey: "" }, { namespace: "n", idempotencyKey: "k".repeat(257) },
  { namespace: "n", idempotencyKey: "\udfff" }, { namespace: "n", idempotencyKey: "k\u0000" },
])("I1: rejects invalid Exchange fields %#", (input) => { invalid(() => normalizeCreateExchangeRequest(input)); });

it.each([
  { exchangeId: "bad" }, { from: {} }, { from: { ...endpoint, secret: "credential" } },
  { from: { ...endpoint, adapter: "" } }, { from: { ...endpoint, adapter: "a".repeat(65) } },
  { from: { ...endpoint, endpointId: "" } }, { from: { ...endpoint, endpointId: "e".repeat(257) } },
  { from: { ...endpoint, instanceId: undefined } }, { from: { ...endpoint, instanceId: "" } },
  { from: { ...endpoint, instanceId: "i".repeat(257) } }, { from: { ...endpoint, endpointId: "\ud800" } },
  { to: null }, { idempotencyKey: "" }, { idempotencyKey: "k".repeat(257) },
  { extra: true }, { payloadDigest: "a".repeat(64) }, { payloadLength: 3 },
])("I1: rejects invalid Message fields %#", (override) => {
  invalid(() => normalizeCreateMessageRequest({ ...messageRequest(), ...override }));
});

it("I1: rejects symbol, hidden, and unknown fields without reading them", () => {
  for (const key of [Symbol("sensitive"), "hidden", "secret"]) {
    const input = messageRequest();
    Object.defineProperty(input, key, { enumerable: key === "secret", get() { throw new Error("MUST_NOT_READ"); } });
    const error = invalid(() => normalizeCreateMessageRequest(input));
    expect(error.message).not.toContain("MUST_NOT_READ");
  }
});

it.each([[], "bytes", new ArrayBuffer(2), new DataView(new ArrayBuffer(2)), 42, null, undefined])(
  "I2: rejects unsupported byte container %#", (payload) => {
    // Preserve explicit undefined rather than the fixture's default.
    invalid(() => normalizeCreateMessageRequest({ ...messageRequest(), payload }));
  },
);

it("I2: accessor and Proxy failures are sanitized without retaining the thrown value", () => {
  const secret = "SECRET-PAYLOAD-ENDPOINT";
  for (const input of [
    Object.defineProperty(messageRequest(), "payload", { get() { throw new Error(secret); } }),
    { ...messageRequest(), from: Object.defineProperty({ ...endpoint }, "adapter", { enumerable: true, get() { throw secret; } }) },
    new Proxy({}, { ownKeys() { throw new Error(secret); } }),
  ]) {
    const error = invalid(() => normalizeCreateMessageRequest(input));
    expect(error.message).not.toContain(secret);
    expect(error.stack).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  }
});

it("B2-1: hostile constructor/species getters are never read", () => {
  let calls = 0;
  const payload = new Uint8Array([4, 5]);
  Object.defineProperty(payload, "constructor", { get() { calls++; throw new Error("constructor"); } });
  const result = normalizeCreateMessageRequest(messageRequest(payload));
  expect(calls).toBe(0);
  expect(result.payloadDigest).toBe(sha256(new Uint8Array([4, 5])));
});

it("B2-1: hostile species accessors and iterators are not invoked", () => {
  let calls = 0;
  const payload = new Uint8Array([6]);
  Object.defineProperty(payload, "constructor", { value: { get [Symbol.species]() { calls++; throw new Error("species"); } } });
  Object.defineProperty(payload, Symbol.iterator, { get() { calls++; throw new Error("iterator"); } });
  expect(normalizeCreateMessageRequest(messageRequest(payload)).payloadDigest).toBe(sha256(new Uint8Array([6])));
  expect(calls).toBe(0);
});

it("copies only the view's byte range, not its whole backing buffer", () => {
  const input = new Uint8Array([99, 1, 2, 88]);
  const payload = new Uint8Array(input.buffer, 1, 2);
  const result = normalizeCreateMessageRequest(messageRequest(payload));
  expect(result.payloadLength).toBe(2);
  expect(result.payloadDigest).toBe(sha256(new Uint8Array([1, 2])));
});

it.each(["Uint8Array", "Buffer"])("B2-2/B2-6: %s caller mutation cannot alter the retained private snapshot", (kind) => {
  const payload = kind === "Buffer" ? Buffer.from([1, 2, 3]) : new Uint8Array([1, 2, 3]);
  const result = normalizeCreateMessageRequest(messageRequest(payload));
  payload.fill(9);
  expect(result.payloadDigest).toBe(sha256(new Uint8Array([1, 2, 3])));
  // No payload reference or byte-returning accessor escapes the normalized object.
  expect(Object.values(result).some((value) => ArrayBuffer.isView(value))).toBe(false);
  expect(Reflect.ownKeys(Object.getPrototypeOf(result))).toEqual(["constructor"]);
  expect(Reflect.ownKeys(result)).not.toContain("payload");
  expect(Object.values(result)).not.toContain(payload);
});

it("B2-3: rejects detached views instead of accepting an apparent empty payload", () => {
  const buffer = new ArrayBuffer(2);
  const payload = new Uint8Array(buffer);
  structuredClone(buffer, { transfer: [buffer] });
  expect(payload.byteLength).toBe(0);
  invalid(() => normalizeCreateMessageRequest(messageRequest(payload)));
});

it("B2-4: rejects SharedArrayBuffer-backed views using the actual backing buffer", () => {
  const payload = new Uint8Array(new SharedArrayBuffer(2));
  Object.defineProperty(payload, "buffer", { value: new ArrayBuffer(2) });
  invalid(() => normalizeCreateMessageRequest(messageRequest(payload)));
});

it.each([new Uint8Array([1]), Buffer.from([1])])("B2-5: rejects Proxy-wrapped byte arrays", (payload) => {
  let traps = 0;
  invalid(() => normalizeCreateMessageRequest(messageRequest(new Proxy(payload, { get() { traps++; throw new Error("proxy"); } }))));
  expect(traps).toBe(0);
});

it.each([0, 1_048_575, 1_048_576, 1_048_577])("B2-7: enforces the copied-byte limit at %i", (size) => {
  const input = messageRequest(new Uint8Array(size));
  expect(MAX_CREATION_PAYLOAD_BYTES).toBe(1_048_576);
  if (size > MAX_CREATION_PAYLOAD_BYTES) invalid(() => normalizeCreateMessageRequest(input));
  else expect(normalizeCreateMessageRequest(input).payloadLength).toBe(size);
});

it("B2-8: ignores hostile own buffer and byteLength getters", () => {
  let calls = 0;
  const payload = new Uint8Array([7, 8, 9]);
  for (const name of ["buffer", "byteLength"]) {
    Object.defineProperty(payload, name, { get() { calls++; throw new Error("hostile length"); } });
  }
  const result = normalizeCreateMessageRequest(messageRequest(payload));
  expect(result.payloadLength).toBe(3);
  expect(result.payloadDigest).toBe(sha256(new Uint8Array([7, 8, 9])));
  expect(calls).toBe(0);
});

it("does not mutate input objects or persist any database state", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-normalize-"));
  const db = new DatabaseSync(join(root, "store.sqlite"));
  try {
    db.exec("CREATE TABLE sentinel(value TEXT)");
    const before = db.prepare("SELECT total_changes() AS n").get();
    const input = messageRequest();
    Object.freeze(input.from); Object.freeze(input.to); Object.freeze(input);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    normalizeCreateMessageRequest(input);
    invalid(() => normalizeCreateMessageRequest({ ...input, idempotencyKey: "" }));
    expect(Object.getOwnPropertyDescriptors(input)).toEqual(descriptors);
    expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    expect(db.prepare("SELECT count(*) AS n FROM sentinel").get()).toEqual({ n: 0 });
    const source = readFileSync(new URL("../../src/storage/creation-request.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/node:sqlite|\.\/(?:store|connection|transaction)\.js/);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

it("test-only resolver loads source normalization in an independent pinned Node process", () => {
  const register = fileURLToPath(new URL("./support/register-ts.mjs", import.meta.url));
  const source = new URL("../../src/storage/creation-request.ts", import.meta.url).href;
  const output = execFileSync(process.execPath, ["--import", register, "--input-type=module", "-e", `
    const { normalizeCreateExchangeRequest } = await import(${JSON.stringify(source)});
    const normalized = normalizeCreateExchangeRequest({ namespace: 'owner', idempotencyKey: 'key' });
    console.log(normalized.requestDigest);
  `], { encoding: "utf8", timeout: 10_000 });
  expect(output.trim()).toBe(canonicalDigest({ op: "chat-exchange/exchange.create", v: 1 }));
});
