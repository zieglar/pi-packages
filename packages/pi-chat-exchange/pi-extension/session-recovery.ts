import * as fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { CeHostRefusal, type CeMappingIdentifiers } from "../dist/endpoints/pi/session-host.js";

type Entry = Record<string, unknown>;
type Store = { readonly directory: string; readonly file: string };
export interface RecoveryAttempt {
  readonly version: 1;
  readonly attemptId: string;
  readonly piSessionId: string;
  readonly endpointId: string;
  readonly store: Store;
  readonly oldMapping: CeMappingIdentifiers;
  readonly failureIds: readonly string[];
  readonly policyIdentity: string;
}
export interface AutomaticRecoveryAttempt extends Omit<RecoveryAttempt, "version"> {
  readonly version: 2;
  readonly mode: "automatic";
  readonly sourceMappingEntryId: string;
}
type Attempt = RecoveryAttempt | AutomaticRecoveryAttempt;
function deny(): never { throw new CeHostRefusal("CE_HOST_MAPPING_INVALID"); }
const record = (value: unknown): value is Entry => typeof value === "object" && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096;
const exact = (value: Entry, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const mappingKeys = ["endpointId", "participantId", "sessionId", "exchangeId"] as const;
export const mappingIdentifiers = (value: unknown): value is CeMappingIdentifiers => record(value) && exact(value, mappingKeys) && mappingKeys.every(key => id(value[key]));
const attemptKeys = ["version", "attemptId", "piSessionId", "endpointId", "store", "oldMapping", "failureIds", "policyIdentity"];
function attempt(value: unknown): value is Attempt {
  if (!record(value)) return false;
  const keys = value.version === 1 ? attemptKeys : value.version === 2 ? [...attemptKeys, "mode", "sourceMappingEntryId"] : [];
  return exact(value, keys) && (value.version === 1 || (value.version === 2 && value.mode === "automatic" && id(value.sourceMappingEntryId))) &&
    id(value.attemptId) && id(value.piSessionId) && id(value.endpointId) && record(value.store) && exact(value.store, ["directory", "file"]) &&
    id(value.store.directory) && id(value.store.file) && mappingIdentifiers(value.oldMapping) && value.oldMapping.endpointId === value.endpointId &&
    Array.isArray(value.failureIds) && value.failureIds.length > 0 && value.failureIds.every(id) && new Set(value.failureIds).size === value.failureIds.length &&
    typeof value.policyIdentity === "string" && /^[a-f0-9]{64}$/.test(value.policyIdentity);
}
export interface RecoveryDiagnostics {
  readonly invalid: boolean;
  readonly failures: readonly Entry[];
}
export interface NativeSessionLifecycle extends RecoveryDiagnostics {
  readonly mapping?: CeMappingIdentifiers;
  readonly sourceMappingEntryId?: string;
  readonly releaseIntent?: "shutdown" | "deactivate" | "legacy";
  readonly hasRecovery: boolean;
  readonly initialRepairEligible: boolean;
}

/** Native append order is evidence only. The caller still needs ordinary
 * policy, process mutex and Host authority checks before adopting a binding. */
export function nativeSessionLifecycle(history: readonly unknown[], piSessionId: string, store: Store): NativeSessionLifecycle {
  const failures: Entry[] = [];
  let hasRecovery = false;
  try {
    if (!id(piSessionId)) deny();
    const entries = new Map<string, { entry: Entry; index: number }>();
    for (const [index, e] of history.entries()) {
      if (!record(e) || !id(e.id) || entries.has(e.id)) deny();
      entries.set(e.id, { entry: e, index });
    }
    const resolved = new Set<string>(), attemptIds = new Set<string>();
    const tuples = new Map<string, string>();
    let mapping: CeMappingIdentifiers | undefined;
    let sourceMappingEntryId: string | undefined;
    let releaseIntent: NativeSessionLifecycle["releaseIntent"];
    let anyRelease = false;
    let pending: { data: Attempt; id: string; index: number; mappingId?: string; newMapping?: CeMappingIdentifiers } | undefined;
    for (const [index, raw] of history.entries()) {
      const e = raw as Entry;
      if (e.type !== "custom") continue;
      const data = e.data;
      switch (e.customType) {
        case "ce-lifecycle-blocked":
          if (!record(data) || !exact(data, ["piSessionId", "endpointId", "code"]) || data.piSessionId !== piSessionId || !id(data.endpointId) || !id(data.code) || pending) deny();
          failures.push(e);
          break;
        case "ce-messaging-released":
          if (!record(data) || !exact(data, [...mappingKeys, "piSessionId", ...(Object.hasOwn(data, "intent") ? ["intent"] : [])]) ||
              data.piSessionId !== piSessionId || !mapping || !mappingKeys.every(key => data[key] === mapping![key]) || pending ||
              (Object.hasOwn(data, "intent") && data.intent !== "shutdown" && data.intent !== "deactivate")) deny();
          releaseIntent = data.intent === undefined ? "legacy" : data.intent as "shutdown" | "deactivate";
          anyRelease = true;
          break;
        case "ce-recovery-attempt": {
          hasRecovery = true;
          if (pending || !attempt(data) || data.piSessionId !== piSessionId || !isDeepStrictEqual(data.store, store) ||
              !isDeepStrictEqual(mapping, data.oldMapping) || releaseIntent || attemptIds.has(data.attemptId)) deny();
          const applicable = failures.filter(f => !resolved.has(String(f.id)));
          if (applicable.some(f => (f.data as Entry).endpointId !== data.endpointId) ||
              !isDeepStrictEqual(new Set(data.failureIds), new Set(applicable.map(f => f.id)))) deny();
          if (data.version === 2 && (tuples.size !== 1 || anyRelease || attemptIds.size !== 0 || data.sourceMappingEntryId !== sourceMappingEntryId)) deny();
          attemptIds.add(data.attemptId);
          pending = { data, id: String(e.id), index };
          break;
        }
        case "ce-mapping": {
          if (!mappingIdentifiers(data)) deny();
          const changed = mapping !== undefined && !isDeepStrictEqual(mapping, data);
          if (pending) {
            if (pending.mappingId || !changed || data.endpointId !== pending.data.endpointId || data.participantId !== pending.data.oldMapping.participantId ||
                data.exchangeId !== pending.data.oldMapping.exchangeId || data.sessionId === pending.data.oldMapping.sessionId) deny();
            pending.mappingId = String(e.id); pending.newMapping = data;
          } else if (changed && !releaseIntent) deny();
          mapping = data;
          const key = JSON.stringify(mappingKeys.map(k => data[k]));
          if (!tuples.has(key)) tuples.set(key, String(e.id));
          sourceMappingEntryId = tuples.get(key)!;
          releaseIntent = undefined;
          break;
        }
        case "ce-recovery-resolved": {
          hasRecovery = true;
          if (!pending || !record(data)) deny();
          const { attemptEntryId, mappingEntryId, newMapping, ...copy } = data;
          if (!attempt(copy) || !isDeepStrictEqual(copy, pending.data) || attemptEntryId !== pending.id || mappingEntryId !== pending.mappingId ||
              !pending.newMapping || !isDeepStrictEqual(newMapping, pending.newMapping) || index <= pending.index ||
              !id(mappingEntryId) || entries.get(mappingEntryId)!.index >= index) deny();
          for (const failureId of pending.data.failureIds) resolved.add(failureId);
          pending = undefined;
          break;
        }
      }
    }
    if (pending || failures.some(f => mapping && (f.data as Entry).endpointId !== mapping.endpointId)) deny();
    const unresolved = failures.filter(f => !resolved.has(String(f.id)));
    return { invalid: false, failures: unresolved, hasRecovery, initialRepairEligible: !hasRecovery && tuples.size === 1 && unresolved.length > 0 && !anyRelease,
      ...(mapping ? { mapping } : {}), ...(sourceMappingEntryId ? { sourceMappingEntryId } : {}), ...(releaseIntent ? { releaseIntent } : {}) };
  } catch {
    return { invalid: true, failures, hasRecovery, initialRepairEligible: false };
  }
}

/** Retained shape for callers migrating from branch-scoped diagnostics. */
export function recoveryDiagnostics(branch: readonly Entry[], history: readonly Entry[] | undefined, piSessionId: string, store: Store): RecoveryDiagnostics {
  const result = nativeSessionLifecycle(history ?? branch, piSessionId, store);
  return { invalid: result.invalid || (history === undefined && result.hasRecovery), failures: result.failures };
}

// Pi owns writes. This descriptor is only a consistency/durability witness,
// never a lock or a substitute for Host admission.
export function openRecoveryJournal(path: string | undefined) {
  if (!path) deny();
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  const initial = fs.fstatSync(fd);
  const assertIdentity = () => {
    const current = fs.fstatSync(fd), named = fs.lstatSync(path);
    if (!current.isFile() || !named.isFile() || current.uid !== process.geteuid?.() || (current.mode & 0o022) !== 0 ||
        current.dev !== initial.dev || current.ino !== initial.ino || current.uid !== initial.uid ||
        named.dev !== current.dev || named.ino !== current.ino || named.uid !== current.uid || named.mode !== current.mode || current.size === 0) deny();
    return current;
  };
  try { assertIdentity(); } catch (error) { fs.closeSync(fd); throw error; }
  let nativeId: string | undefined;
  const readHistory = (piSessionId?: string) => {
    const before = assertIdentity();
    if (before.size > 64 * 1024 * 1024) deny();
    const buffer = Buffer.alloc(before.size);
    if (fs.readSync(fd, buffer, 0, buffer.length, 0) !== buffer.length) deny();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    const lines = text.split("\n");
    if (lines.pop() !== "") deny();
    let values: unknown[];
    try { values = lines.map(line => JSON.parse(line)); } catch { deny(); }
    const header = values.shift();
    if (!record(header) || header.type !== "session" || header.version !== 3 || !id(header.id) ||
        (piSessionId !== undefined && header.id !== piSessionId) || (nativeId !== undefined && header.id !== nativeId) || !id(header.timestamp) || !id(header.cwd) ||
        !exact(header, ["type", "version", "id", "timestamp", "cwd", ...(Object.hasOwn(header, "parentSession") ? ["parentSession"] : [])]) ||
        (Object.hasOwn(header, "parentSession") && !id(header.parentSession))) deny();
    const ids = new Set<string>([header.id]);
    for (const e of values) {
      if (!record(e) || !id(e.id) || !id(e.type) || e.type === "session" || ids.has(e.id)) deny();
      ids.add(e.id);
    }
    const assertUnchanged = () => {
      const after = assertIdentity();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) deny();
    };
    assertUnchanged();
    return { values, nativeId: header.id, assertUnchanged };
  };
  let expected: unknown[] | undefined;
  return {
    assertIdentity,
    verifyHistory(entries: readonly unknown[], piSessionId: string): void {
      let snapshot: unknown[];
      try { snapshot = JSON.parse(JSON.stringify(entries)); } catch { deny(); }
      const read = readHistory(piSessionId);
      if (!Array.isArray(snapshot) || !isDeepStrictEqual(read.values, snapshot) ||
          (expected && !isDeepStrictEqual(snapshot, expected))) deny();
      read.assertUnchanged();
      nativeId = read.nativeId;
      expected = snapshot;
    },
    verify(entry: unknown): void {
      if (!record(entry) || !id(entry.id)) deny();
      let snapshot: Entry;
      try { snapshot = JSON.parse(JSON.stringify(entry)); } catch { deny(); }
      const read = readHistory();
      if (expected) {
        const next = [...expected, snapshot];
        // Callers may have verified the just-appended full snapshot already.
        if (!isDeepStrictEqual(read.values, next) && !isDeepStrictEqual(read.values, expected)) deny();
        if (!isDeepStrictEqual(read.values.at(-1), snapshot)) deny();
      } else if (read.values.filter(e => record(e) && e.id === entry.id).length !== 1 || !isDeepStrictEqual(read.values.at(-1), snapshot)) deny();
      fs.fsyncSync(fd);
      read.assertUnchanged();
      nativeId = read.nativeId;
      expected = read.values;
    },
    close(): void { fs.closeSync(fd); },
  };
}
