/** Local operator selection, scoped to a trusted CE caller launch, never a
 * ChatGPT conversation or message permission. No remote mutation API exists. */
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, normalize } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { parseMcpBindingConfig, type McpBindingConfig } from "../host/mcp-binding-config.js";
import { readPrivateMessagingFile } from "./messaging-config.js";
import { readLivePolicy } from "./live-session-policy.js";
import { discoverCurrentRuntimes, RUNTIME_ID_PATTERN } from "./current-runtime-binding.js";

const runtime = Type.String({pattern: RUNTIME_ID_PATTERN});
const revision = Type.String({pattern: "^(unbound|[a-f0-9]{64})$"});
export const RUNTIME_GROUP_PATTERN = "^[a-z0-9][a-z0-9._-]{0,63}$";
export function normalizeRuntimeGroup(name: string): string {
  const normalized = name.normalize("NFKC").toLowerCase();
  if (!new RegExp(RUNTIME_GROUP_PATTERN).test(normalized)) throw refusal("INVALID");
  return normalized;
}
const groupName = Type.String({pattern: RUNTIME_GROUP_PATTERN});
const recordFields = {scopeDigest: Type.String({pattern: "^[a-f0-9]{64}$"}),
  nonce: Type.String({pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$"}), runtimeId: Type.Union([runtime, Type.Null()])};
const groupFields = {name: groupName, runtimeId: Type.Union([runtime, Type.Null()])};
const RecordSchema = Type.Union([
  Type.Object({version: Type.Literal(1), ...recordFields}, {additionalProperties: false}),
  Type.Object({version: Type.Literal(2), ...recordFields, groups: Type.Array(Type.Object(groupFields, {additionalProperties: false}), {maxItems: 128})}, {additionalProperties: false}),
]);
const UpdateSchema = Type.Object({runtimeId: Type.Union([runtime, Type.Null()]), expectedRevision: revision,
  acceptEndpointScope: Type.Literal(true)}, {additionalProperties: false});
const groupCommon = {group: Type.String({minLength: 1, maxLength: 256}), expectedRevision: revision, acceptEndpointScope: Type.Literal(true)};
const GroupUpdateSchema = Type.Union([
  Type.Object({...groupCommon, action: Type.Union([Type.Literal("bind"), Type.Literal("rebind")]), runtimeId: runtime}, {additionalProperties: false}),
  Type.Object({...groupCommon, action: Type.Literal("revoke")}, {additionalProperties: false}),
  Type.Object({...groupCommon, action: Type.Literal("rename"), nextName: Type.String({minLength: 1, maxLength: 256})}, {additionalProperties: false}),
]);
export type RuntimeSelection = (
  | {readonly scope: "ce-endpoint"; readonly status: "unavailable"}
  | {readonly scope: "ce-endpoint"; readonly status: "unbound"; readonly revision: string}
  | {readonly scope: "ce-endpoint"; readonly status: "bound"; readonly revision: string; readonly runtimeId: string}) & {readonly group?: string};
interface Catalog {revision: string; runtimeId: string | null; groups: {name: string; runtimeId: string | null}[];}
const unavailable = (group?: string): RuntimeSelection => ({scope: "ce-endpoint", status: "unavailable", ...(group === undefined ? {} : {group})});
const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const refusal = (kind: "INVALID" | "CONFLICT" | "RUNTIME_UNAVAILABLE" | "WRITE_UNCERTAIN" | "GROUP_EXISTS" | "GROUP_UNBOUND" | "GROUP_LIMIT"): Error => new Error(`CE_RUNTIME_BINDING_${kind}`);
function privateDirectory(path: string): void {
  if (!isAbsolute(path) || normalize(path) !== path || fs.realpathSync(path) !== path) throw refusal("INVALID");
  const stat = fs.lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.geteuid?.() || (stat.mode & 0o7777) !== 0o700) throw refusal("INVALID");
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const s = fs.lstatSync(parent), stickyRoot = s.uid === 0 && (s.mode & 0o1000) !== 0;
    if (!s.isDirectory() || (s.uid !== 0 && s.uid !== process.geteuid?.()) || ((s.mode & 0o022) !== 0 && !stickyRoot)) throw refusal("INVALID");
    if (dirname(parent) === parent) break;
  }
}

/** The host supplies this config; model arguments never choose caller identity.
 * A different immutable config has a different sidecar scope and starts unbound. */
export function createEndpointRuntimeBinding(bindingPath: string, config: McpBindingConfig) {
  const parent = dirname(bindingPath);privateDirectory(parent);
  const launch = readPrivateMessagingFile(bindingPath);
  if (launch === undefined || !isDeepStrictEqual(parseMcpBindingConfig(JSON.parse(launch.bytes.toString("utf8"))), config) ||
      config.endpoint.adapter !== "chatgpt" || config.admissionPolicy === undefined ||
      (config.admissionPolicy.kind !== "ce-live-session-v1" && config.admissionPolicy.kind !== "ce-live-session-v2")) throw refusal("INVALID");
  const ref = config.admissionPolicy, scopeDigest = hash(launch.bytes);
  const path = bindingPath + ".runtime-binding.json", lock = path + ".lock";
  const locked = (): boolean => {try {fs.lstatSync(lock);return true;} catch (error) {if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;throw error;}};
  const readCatalog = (ownLock = false): Catalog | undefined => {
    try {
      privateDirectory(parent);
      const selected = readPrivateMessagingFile(bindingPath);
      if (selected === undefined || hash(selected.bytes) !== scopeDigest || !ownLock && locked()) return;
      const file = readPrivateMessagingFile(path);
      if (!ownLock && locked()) return;
      if (file === undefined) return {revision: "unbound", runtimeId: null, groups: []};
      const value: unknown = JSON.parse(file.bytes.toString("utf8"));
      if (!Value.Check(RecordSchema, value) || value.scopeDigest !== scopeDigest) return;
      const groups = value.version === 1 ? [] : value.groups;
      if (new Set(groups.map(g => g.name)).size !== groups.length) return;
      return {revision: hash(file.bytes), runtimeId: value.runtimeId, groups};
    } catch {return;}
  };
  const selection = (catalog: Catalog | undefined, group?: string): RuntimeSelection => {
    if (catalog === undefined) return unavailable(group);
    const runtimeId = group === undefined ? catalog.runtimeId : catalog.groups.find(g => g.name === group)?.runtimeId;
    const common = {scope: "ce-endpoint" as const, revision: catalog.revision, ...(group === undefined ? {} : {group})};
    return runtimeId == null ? {...common, status: "unbound"} : {...common, status: "bound", runtimeId};
  };
  const syncParent = (): void => {const fd = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}};
  const assertRuntime = (runtimeId: string): void => {
    const snapshot = readLivePolicy(ref), manifest = snapshot.manifest;
    if (!isDeepStrictEqual(manifest.store, config.store) || !isDeepStrictEqual(manifest.exchange, config.exchange) ||
      !isDeepStrictEqual(manifest.chatgptEndpoint, config.endpoint) || manifest.mcp.payloadRead !== config.payloadRead.enabled || manifest.mcp.ack !== config.ack.enabled) throw refusal("INVALID");
    const visible = manifest.registrations.filter(r => r.status === "active" && r.presenceDisclosure).map(r => r.endpointId);
    if (discoverCurrentRuntimes(snapshot, visible, runtimeId).currentBinding?.status !== "verified") throw refusal("RUNTIME_UNAVAILABLE");
  };
  const commit = (expectedRevision: string, mutate: (catalog: Catalog) => void, group?: string): RuntimeSelection => {
    privateDirectory(parent);
    try {fs.mkdirSync(lock, {mode: 0o700});} catch {throw refusal("CONFLICT");}
    let writing = false;
    try {
      const before = readCatalog(true);
      if (before === undefined) throw refusal("INVALID");
      if (before.revision !== expectedRevision) throw refusal("CONFLICT");
      mutate(before);
      const stage = path + ".stage-" + randomUUID();
      // Legacy-only writes retain version 1; a named write upgrades once and
      // keeps the unnamed selection. All names share one lock and revision.
      const bytes = Buffer.from(JSON.stringify({version: before.groups.length ? 2 : 1, scopeDigest, nonce: randomUUID(),
        runtimeId: before.runtimeId, ...(before.groups.length ? {groups: before.groups.sort((a, b) => a.name.localeCompare(b.name))} : {})}) + "\n");
      // Once IO begins an exception may leave durable state uncertain. Keep the
      // lock for offline reconciliation; never infer failure means no change.
      writing = true;
      const fd = fs.openSync(stage, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try {fs.writeFileSync(fd, bytes);fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
      fs.renameSync(stage, path);syncParent();
      const committed = selection(readCatalog(true), group);
      if (committed.status === "unavailable") throw refusal("WRITE_UNCERTAIN");
      fs.rmdirSync(lock);
      // Return the commit captured under our lock, not a successor's state.
      return committed;
    } catch (error) {
      if (!writing) fs.rmdirSync(lock);
      if (writing) throw refusal("WRITE_UNCERTAIN");
      throw error;
    }
  };
  return Object.freeze({
    read: (): RuntimeSelection => selection(readCatalog()),
    readGroup: (name: string): RuntimeSelection => selection(readCatalog(), normalizeRuntimeGroup(name)),
    listGroups: (): RuntimeSelection[] => {
      const catalog = readCatalog();
      if (catalog === undefined) throw refusal("INVALID");
      return catalog.groups.map(g => selection(catalog, g.name));
    },
    update(input: unknown): RuntimeSelection {
      if (!Value.Check(UpdateSchema, input)) throw refusal("INVALID");
      return commit(input.expectedRevision, catalog => {
        if (input.runtimeId !== null) assertRuntime(input.runtimeId);
        catalog.runtimeId = input.runtimeId;
      });
    },
    updateGroup(input: unknown): RuntimeSelection {
      if (!Value.Check(GroupUpdateSchema, input)) throw refusal("INVALID");
      const group = normalizeRuntimeGroup(input.group), nextName = input.action === "rename" ? normalizeRuntimeGroup(input.nextName) : undefined;
      return commit(input.expectedRevision, catalog => {
        const current = catalog.groups.find(g => g.name === group);
        if (input.action === "rename") {
          if (current === undefined) throw refusal("GROUP_UNBOUND");
          if (catalog.groups.some(g => g.name === nextName)) throw refusal("GROUP_EXISTS");
          current.name = nextName!;
        } else if (input.action === "revoke") {
          if (current?.runtimeId == null) throw refusal("GROUP_UNBOUND");
          current.runtimeId = null;
        } else {
          if (input.action === "bind" && current?.runtimeId != null) throw refusal("GROUP_EXISTS");
          if (input.action === "rebind" && current?.runtimeId == null) throw refusal("GROUP_UNBOUND");
          if (current === undefined && catalog.groups.length >= 128) throw refusal("GROUP_LIMIT");
          assertRuntime(input.runtimeId);
          if (current === undefined) catalog.groups.push({name: group, runtimeId: input.runtimeId});
          else current.runtimeId = input.runtimeId;
        }
      }, nextName ?? group);
    },
  });
}
