import fs from "node:fs";
import { createHash, randomBytes as secureRandomBytes, randomUUID } from "node:crypto";
import { isAbsolute, join, normalize } from "node:path";

export interface PairingIdentity {
  readonly runtimeSessionId: string;
  readonly exchangeId: string;
  readonly endpointId: string;
}

export interface PairingReceipt extends PairingIdentity {
  readonly from: string;
  readonly capabilityDigest: string;
  readonly redeemedAt: number;
}

interface PairingRecord extends PairingIdentity {
  readonly version: 1;
  readonly from: string;
  readonly capabilityDigest: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

interface PairingPointer {
  readonly version: 1;
  readonly runtimeSessionId: string;
  readonly capabilityDigest: string;
}

export type PairingRefusal =
  | "PAIRING_UNKNOWN"
  | "PAIRING_NOT_CURRENT"
  | "PAIRING_IDENTITY_MISMATCH"
  | "PAIRING_EXPIRED"
  | "PAIRING_ALREADY_REDEEMED";

const PAIRING_TTL_MS = 5 * 60 * 1000;
const TOKEN = /^ce_pair_[A-Za-z0-9_-]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/;

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

export function pairingExchangeIdentity(exchange: { readonly namespace: string; readonly idempotencyKey: string }): string {
  return hash(JSON.stringify({ namespace: label(exchange.namespace, "exchange.namespace"), idempotencyKey: label(exchange.idempotencyKey, "exchange.idempotencyKey") }));
}

function label(value: string, name: string): string {
  if (!value || value.length > 256 || /[\u0000-\u0020\u007f-\u009f]/.test(value) || /cap_[0-9a-f]{16,}/i.test(value)) {
    throw new Error(`invalid ${name}`);
  }
  return value;
}

function validateIdentity(identity: PairingIdentity): PairingIdentity {
  return Object.freeze({
    runtimeSessionId: label(identity.runtimeSessionId, "runtimeSessionId"),
    exchangeId: label(identity.exchangeId, "exchangeId"),
    endpointId: label(identity.endpointId, "endpointId"),
  });
}

function pairingDirectory(directory: string): string {
  if (!isAbsolute(directory) || normalize(directory) !== directory || directory === "/") throw new Error("invalid pairing directory");
  const root = fs.realpathSync(directory);
  if (root !== directory) throw new Error("invalid pairing directory");
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0) throw new Error("insecure pairing directory");
  const path = join(root, "pairing");
  try { fs.mkdirSync(path, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = fs.lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("insecure pairing directory");
  return path;
}

const recordPath = (root: string, digest: string): string => join(root, `cap-${digest}.json`);
const receiptPath = (root: string, digest: string): string => join(root, `receipt-${digest}.json`);
const pointerPath = (root: string, runtimeSessionId: string): string => join(root, `current-${hash(runtimeSessionId)}.json`);

function atomicWrite(path: string, value: unknown): void {
  const directory = join(path, "..");
  const temp = join(directory, `.pairing-${randomUUID()}.tmp`);
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value), "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try { fs.renameSync(temp, path); } catch (error) { try { fs.unlinkSync(temp); } catch { /* best effort */ } throw error; }
}

function readJson(path: string): unknown | undefined {
  let text: string;
  try { text = fs.readFileSync(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (text.length > 8192) throw new Error("pairing state too large");
  return JSON.parse(text) as unknown;
}

function parsePointer(value: unknown): PairingPointer {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid pairing pointer");
  const v = value as Record<string, unknown>;
  if (Reflect.ownKeys(v).length !== 3 || v.version !== 1 || typeof v.runtimeSessionId !== "string" || typeof v.capabilityDigest !== "string" || !DIGEST.test(v.capabilityDigest)) throw new Error("invalid pairing pointer");
  return { version: 1, runtimeSessionId: label(v.runtimeSessionId, "runtimeSessionId"), capabilityDigest: v.capabilityDigest };
}

function parseRecord(value: unknown): PairingRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid pairing record");
  const v = value as Record<string, unknown>;
  const keys = ["version", "runtimeSessionId", "exchangeId", "endpointId", "from", "capabilityDigest", "createdAt", "expiresAt"];
  if (Reflect.ownKeys(v).length !== keys.length || keys.some(key => !Object.hasOwn(v, key)) || v.version !== 1 || typeof v.from !== "string" || typeof v.capabilityDigest !== "string" || !DIGEST.test(v.capabilityDigest) || typeof v.createdAt !== "number" || typeof v.expiresAt !== "number" || !Number.isSafeInteger(v.createdAt) || !Number.isSafeInteger(v.expiresAt) || v.expiresAt !== v.createdAt + PAIRING_TTL_MS) throw new Error("invalid pairing record");
  const identity = validateIdentity(v as unknown as PairingIdentity);
  return { version: 1, ...identity, from: label(v.from, "from"), capabilityDigest: v.capabilityDigest, createdAt: v.createdAt, expiresAt: v.expiresAt };
}

function parseReceipt(value: unknown): PairingReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid pairing receipt");
  const v = value as Record<string, unknown>;
  const keys = ["runtimeSessionId", "exchangeId", "endpointId", "from", "capabilityDigest", "redeemedAt"];
  if (Reflect.ownKeys(v).length !== keys.length || keys.some(key => !Object.hasOwn(v, key)) || typeof v.from !== "string" || typeof v.capabilityDigest !== "string" || !DIGEST.test(v.capabilityDigest) || typeof v.redeemedAt !== "number" || !Number.isSafeInteger(v.redeemedAt)) throw new Error("invalid pairing receipt");
  return { ...validateIdentity(v as unknown as PairingIdentity), from: label(v.from, "from"), capabilityDigest: v.capabilityDigest, redeemedAt: v.redeemedAt };
}

export function createPairingCapability(options: {
  readonly directory: string;
  readonly identity: PairingIdentity;
  readonly from?: string;
  readonly now?: number;
  readonly randomBytes?: () => Buffer;
}): { readonly secret: string; readonly capabilityDigest: string; readonly command: string; readonly from: string; readonly expiresAt: number } {
  const root = pairingDirectory(options.directory);
  const identity = validateIdentity(options.identity);
  const from = label(options.from ?? "chatgpt/main", "from");
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid pairing time");
  const bytes = (options.randomBytes ?? (() => secureRandomBytes(24)))();
  if (!Buffer.isBuffer(bytes) || bytes.length !== 24) throw new Error("invalid pairing randomness");
  const secret = `ce_pair_${bytes.toString("base64url")}`;
  const capabilityDigest = hash(secret);
  const record: PairingRecord = { version: 1, ...identity, from, capabilityDigest, createdAt: now, expiresAt: now + PAIRING_TTL_MS };
  atomicWrite(recordPath(root, capabilityDigest), record);
  atomicWrite(pointerPath(root, identity.runtimeSessionId), { version: 1, runtimeSessionId: identity.runtimeSessionId, capabilityDigest } satisfies PairingPointer);
  return Object.freeze({ secret, capabilityDigest, command: `/ce pair ${secret} --from ${from}`, from, expiresAt: record.expiresAt });
}

export function redeemPairingCapability(options: {
  readonly directory: string;
  readonly secret: string;
  readonly exchangeId: string;
  readonly from?: string;
  readonly now?: number;
}): { readonly status: "accepted"; readonly from: string; readonly expiresAt: number } | { readonly status: "refused"; readonly reason: PairingRefusal } {
  if (!TOKEN.test(options.secret)) return { status: "refused", reason: "PAIRING_UNKNOWN" };
  const root = pairingDirectory(options.directory);
  const capabilityDigest = hash(options.secret);
  const raw = readJson(recordPath(root, capabilityDigest));
  if (raw === undefined) return { status: "refused", reason: "PAIRING_UNKNOWN" };
  const record = parseRecord(raw);
  const pointerRaw = readJson(pointerPath(root, record.runtimeSessionId));
  if (pointerRaw === undefined || parsePointer(pointerRaw).capabilityDigest !== capabilityDigest) return { status: "refused", reason: "PAIRING_NOT_CURRENT" };
  if (record.exchangeId !== label(options.exchangeId, "exchangeId")) return { status: "refused", reason: "PAIRING_IDENTITY_MISMATCH" };
  const now = options.now ?? Date.now();
  if (now > record.expiresAt) return { status: "refused", reason: "PAIRING_EXPIRED" };
  if (readJson(receiptPath(root, capabilityDigest)) !== undefined) return { status: "refused", reason: "PAIRING_ALREADY_REDEEMED" };
  const from = label(options.from ?? record.from, "from");
  atomicWrite(receiptPath(root, capabilityDigest), { runtimeSessionId: record.runtimeSessionId, exchangeId: record.exchangeId, endpointId: record.endpointId, from, capabilityDigest, redeemedAt: now } satisfies PairingReceipt);
  return Object.freeze({ status: "accepted", from, expiresAt: record.expiresAt });
}

export function inspectPairingReceipt(options: {
  readonly directory: string;
  readonly identity: PairingIdentity;
  readonly now?: number;
}): { readonly status: "missing" | "pending" | "expired" } | { readonly status: "redeemed"; readonly receipt: PairingReceipt } {
  const root = pairingDirectory(options.directory);
  const identity = validateIdentity(options.identity);
  const pointerRaw = readJson(pointerPath(root, identity.runtimeSessionId));
  if (pointerRaw === undefined) return { status: "missing" };
  const pointer = parsePointer(pointerRaw);
  if (pointer.runtimeSessionId !== identity.runtimeSessionId) return { status: "missing" };
  const recordRaw = readJson(recordPath(root, pointer.capabilityDigest));
  if (recordRaw === undefined) return { status: "missing" };
  const record = parseRecord(recordRaw);
  if (record.runtimeSessionId !== identity.runtimeSessionId || record.exchangeId !== identity.exchangeId || record.endpointId !== identity.endpointId) return { status: "missing" };
  if ((options.now ?? Date.now()) > record.expiresAt) return { status: "expired" };
  const receiptRaw = readJson(receiptPath(root, pointer.capabilityDigest));
  return receiptRaw === undefined ? { status: "pending" } : { status: "redeemed", receipt: Object.freeze(parseReceipt(receiptRaw)) };
}

export function consumePairingReceipt(options: { readonly directory: string; readonly identity: PairingIdentity; readonly capabilityDigest: string }): boolean {
  if (!DIGEST.test(options.capabilityDigest)) return false;
  const root = pairingDirectory(options.directory);
  const identity = validateIdentity(options.identity);
  const pointer = readJson(pointerPath(root, identity.runtimeSessionId));
  if (pointer === undefined || parsePointer(pointer).capabilityDigest !== options.capabilityDigest) return false;
  const receipt = readJson(receiptPath(root, options.capabilityDigest));
  if (receipt === undefined) return false;
  const parsed = parseReceipt(receipt);
  if (parsed.runtimeSessionId !== identity.runtimeSessionId || parsed.exchangeId !== identity.exchangeId || parsed.endpointId !== identity.endpointId) return false;
  for (const path of [pointerPath(root, identity.runtimeSessionId), recordPath(root, options.capabilityDigest), receiptPath(root, options.capabilityDigest)]) {
    try { fs.unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return true;
}
