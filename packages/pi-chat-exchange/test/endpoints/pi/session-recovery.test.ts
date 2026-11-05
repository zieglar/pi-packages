import fs, { fsyncSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { nativeSessionLifecycle, openRecoveryJournal, recoveryDiagnostics } from "../../../pi-extension/session-recovery.js";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const path of directories.splice(0)) fs.rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const store = { directory: "/isolated/store", file: "test.sqlite" };
  const oldMapping = { endpointId: "pi/A", participantId: "participant", sessionId: "old", exchangeId: "exchange" };
  const newMapping = { ...oldMapping, sessionId: "new" };
  const attempt = { version: 1, attemptId: "attempt", piSessionId: "native", endpointId: "pi/A", store, oldMapping, failureIds: ["blocked"], policyIdentity: "a".repeat(64) };
  const entries: Array<Record<string, any>> = [
    { type: "custom", id: "old", customType: "ce-mapping", data: oldMapping },
    { type: "custom", id: "blocked", customType: "ce-lifecycle-blocked", data: { piSessionId: "native", endpointId: "pi/A", code: "CE_HOST_AUTHORITY_ABSENT" } },
    { type: "custom", id: "attempt", customType: "ce-recovery-attempt", data: attempt },
    { type: "custom", id: "new", customType: "ce-mapping", data: newMapping },
    { type: "custom", id: "resolved", customType: "ce-recovery-resolved", data: { ...attempt, attemptEntryId: "attempt", mappingEntryId: "new", newMapping } },
  ];
  return { store, entries, inspect: (branch = entries, history: typeof entries | undefined = entries) => recoveryDiagnostics(branch, history, "native", store) };
}
it("complete commit resolves only exact enumerated preceding failures; identical resume mapping is allowed", () => {
  const f = fixture(); expect(f.inspect()).toEqual({ invalid: false, failures: [] });
  f.entries.push({ type: "custom", id: "resume", customType: "ce-mapping", data: f.entries[3]!.data });
  expect(f.inspect()).toEqual({ invalid: false, failures: [] });
});
it("allows later ordinary mapping only after an exact intervening release of its predecessor", () => {
  const f = fixture(); const recovered = f.entries[3]!.data;
  f.entries.push({ type: "custom", id: "release", customType: "ce-messaging-released", data: { piSessionId: "native", ...recovered } },
    { type: "custom", id: "reactivated", customType: "ce-mapping", data: { ...recovered, sessionId: "reactivated" } });
  expect(f.inspect()).toEqual({ invalid: false, failures: [] });
  for (const change of ["missing", "wrong-native", "wrong-mapping", "too-early"]) {
    const altered = structuredClone(f.entries);
    if (change === "missing") altered.splice(5, 1);
    if (change === "wrong-native") altered[5]!.data.piSessionId = "foreign";
    if (change === "wrong-mapping") altered[5]!.data.sessionId = "foreign";
    if (change === "too-early") altered.splice(0, 0, altered.splice(5, 1)[0]!);
    expect(recoveryDiagnostics(altered, altered, "native", f.store).invalid).toBe(true);
  }
});

it.each(["attempt-only", "mapping-only", "partial-commit", "wrong-mapping", "same-session", "wrong-store", "wrong-scope", "unknown-failure", "duplicate-id", "missing-id", "extra-data", "duplicate-commit", "later-failure-id", "orphan-commit"])("denies %s journal", change => {
  const f = fixture();
  if (change === "attempt-only") f.entries.splice(3);
  if (change === "mapping-only") { f.entries.splice(2, 1); f.entries.splice(3); }
  if (change === "partial-commit") delete f.entries[4]!.data.mappingEntryId;
  if (change === "wrong-mapping") f.entries[4]!.data.newMapping = { ...f.entries[3]!.data, participantId: "foreign" };
  if (change === "same-session") f.entries[4]!.data.newMapping = f.entries[0]!.data;
  if (change === "wrong-store") f.entries[4]!.data.store = { ...f.store, file: "foreign.sqlite" };
  if (change === "wrong-scope") f.entries[4]!.data.endpointId = "pi/B";
  if (change === "unknown-failure") f.entries[4]!.data.failureIds = ["unknown"];
  if (change === "duplicate-id") f.entries[3]!.id = "old";
  if (change === "missing-id") delete f.entries[1]!.id;
  if (change === "extra-data") f.entries[4]!.data.credentials = "must-refuse";
  if (change === "duplicate-commit") f.entries.push({ ...f.entries[4], id: "duplicate" });
  if (change === "later-failure-id") f.entries.push(f.entries.splice(1, 1)[0]!);
  if (change === "orphan-commit") f.entries.splice(2, 1);
  const result = f.inspect(); expect(result.invalid || result.failures.length > 0).toBe(true);
});
it("full history retains complete commits across conversational rollback", () => {
  const f = fixture();
  for (const branch of [f.entries.slice(0, 2), f.entries.slice(0, 4), f.entries.filter(e => e.id !== "new"), f.entries.filter(e => e.id !== "blocked")]) expect(f.inspect(branch)).toEqual({ invalid: false, failures: [] });
  expect(recoveryDiagnostics(f.entries, undefined, "native", f.store).invalid).toBe(true);
  f.entries.push({ type: "custom", id: "unfinished", customType: "ce-recovery-attempt", data: { ...f.entries[2]!.data, attemptId: "second" } });
  expect(f.inspect(f.entries.slice(0, 5)).invalid).toBe(true);
});
it("a later complete recovery resolves its newer failure and selects its branch mapping", () => {
  const f = fixture(); const previous = f.entries[3]!.data;
  const laterMapping = { ...previous, sessionId: "later" };
  const a = { ...f.entries[2]!.data, attemptId: "later-attempt", oldMapping: previous, failureIds: ["later-failure"] };
  f.entries.push(
    { type: "custom", id: "later-failure", customType: "ce-lifecycle-blocked", data: { piSessionId: "native", endpointId: "pi/A", code: "CE_HOST_UNCERTAIN" } },
    { type: "custom", id: "later-attempt", customType: "ce-recovery-attempt", data: a },
    { type: "custom", id: "later-mapping", customType: "ce-mapping", data: laterMapping },
    { type: "custom", id: "later-resolved", customType: "ce-recovery-resolved", data: { ...a, attemptEntryId: "later-attempt", mappingEntryId: "later-mapping", newMapping: laterMapping } },
  );
  expect(f.inspect()).toEqual({ invalid: false, failures: [] });
});
it.each([false, true])("validates ordinary transitions between recovery commits, release=%s", released => {
  const f = fixture(); const recovered = f.entries[3]!.data;
  const intermediate = { ...recovered, sessionId: "intermediate" };
  const later = { ...intermediate, sessionId: "later" };
  if (released) f.entries.push({ type: "custom", id: "release", customType: "ce-messaging-released", data: { piSessionId: "native", ...recovered } });
  const a = { ...f.entries[2]!.data, attemptId: "second-attempt", oldMapping: intermediate, failureIds: ["second-failure"] };
  f.entries.push(
    { type: "custom", id: "intermediate", customType: "ce-mapping", data: intermediate },
    { type: "custom", id: "second-failure", customType: "ce-lifecycle-blocked", data: { piSessionId: "native", endpointId: "pi/A", code: "CE_HOST_UNCERTAIN" } },
    { type: "custom", id: "second-attempt", customType: "ce-recovery-attempt", data: a },
    { type: "custom", id: "later", customType: "ce-mapping", data: later },
    { type: "custom", id: "second-commit", customType: "ce-recovery-resolved", data: { ...a, attemptEntryId: "second-attempt", mappingEntryId: "later", newMapping: later } },
  );
  expect(f.inspect().invalid).toBe(!released);
  if (released) expect(f.inspect().failures).toEqual([]);
});

it("any incomplete attempt in full history denies even when its native scope mismatches", () => {
  const f = fixture(); f.entries.push({ type: "custom", id: "foreign-attempt", customType: "ce-recovery-attempt", data: { ...f.entries[2]!.data, piSessionId: "foreign" } });
  expect(f.inspect().invalid).toBe(true);
});
it("a bare new mapping never resolves a lifecycle marker; missing history keeps existing fail-closed behavior", () => {
  const f = fixture(); f.entries.splice(4); f.entries.splice(2, 1);
  expect(f.inspect().failures).toHaveLength(1);
  expect(recoveryDiagnostics(f.entries, undefined, "native", f.store).failures).toHaveLength(1);
});
function nativeFile() {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ce-recovery-journal-"))); directories.push(dir); fs.chmodSync(dir, 0o700);
  const path = join(dir, "native.jsonl"); const entry = { type: "custom", customType: "ce-recovery-attempt", id: "stable", data: { identifier: "only" } };
  fs.writeFileSync(path, JSON.stringify({ type: "session", version: 3, id: "native", timestamp: new Date().toISOString(), cwd: dir }) + "\n" + JSON.stringify(entry) + "\n", { mode: 0o644 });
  return { dir, path, entry };
}
it("readback verifies exact actual native entry and syncs an existing 0644 regular file", () => {
  const f = nativeFile(); const journal = openRecoveryJournal(f.path);
  try { journal.verify(f.entry); expect(() => journal.verify({ ...f.entry, data: { identifier: "different" } })).toThrow(); }
  finally { journal.close(); }
});
it.each(["missing", "symlink", "public-write", "directory", "empty", "replacement", "truncated", "duplicate"])("refuses unsafe native file %s", change => {
  const f = nativeFile();
  if (change === "missing") { expect(() => openRecoveryJournal(undefined)).toThrow(); return; }
  if (change === "symlink") { fs.symlinkSync(f.path, join(f.dir, "alias")); expect(() => openRecoveryJournal(join(f.dir, "alias"))).toThrow(); return; }
  if (change === "public-write") { fs.chmodSync(f.path, 0o666); expect(() => openRecoveryJournal(f.path)).toThrow(); return; }
  if (change === "directory") { expect(() => openRecoveryJournal(f.dir)).toThrow(); return; }
  if (change === "empty") { fs.truncateSync(f.path); expect(() => openRecoveryJournal(f.path)).toThrow(); return; }
  const journal = openRecoveryJournal(f.path);
  try {
    if (change === "replacement") { fs.renameSync(f.path, f.path + ".old"); fs.writeFileSync(f.path, JSON.stringify(f.entry) + "\n"); }
    if (change === "tail") fs.appendFileSync(f.path, JSON.stringify({ id: "large", data: "x".repeat(300_000) }) + "\n");
    if (change === "truncated") fs.appendFileSync(f.path, "partial");
    if (change === "duplicate") fs.appendFileSync(f.path, JSON.stringify(f.entry) + "\n");
    expect(() => journal.verify(f.entry)).toThrow();
  } finally { journal.close(); }
});

it("projects initial repair from the earliest equivalent mapping and all native failures", () => {
  const f = fixture(); f.entries.splice(2);
  f.entries.push({ ...f.entries[0], id: "resume" });
  expect(nativeSessionLifecycle(f.entries, "native", f.store)).toMatchObject({ invalid: false,
    mapping: f.entries[0]!.data, sourceMappingEntryId: "old", hasRecovery: false, initialRepairEligible: true });
  f.entries.push({ type: "custom", id: "release", customType: "ce-messaging-released", data: { ...f.entries[0]!.data, piSessionId: "native", intent: "deactivate" } });
  expect(nativeSessionLifecycle(f.entries, "native", f.store)).toMatchObject({ invalid: false, releaseIntent: "deactivate", initialRepairEligible: false });
});
it.each(["foreign-failure", "omitted-failure", "precommit-transition", "unknown-version", "bad-source", "unknown-release", "malformed-failure"])("refuses full-history ambiguity: %s", change => {
  const f = fixture();
  if (change === "foreign-failure") f.entries[1]!.data.endpointId = "pi/B";
  if (change === "omitted-failure") f.entries.splice(2, 0, { ...f.entries[1], id: "omitted" });
  if (change === "precommit-transition") f.entries.unshift({ ...f.entries[0], id: "earlier", data: { ...f.entries[0]!.data, sessionId: "unexplained" } });
  if (change === "unknown-version") f.entries[2]!.data.version = f.entries[4]!.data.version = 3;
  if (change === "bad-source") for (const i of [2, 4]) Object.assign(f.entries[i]!.data, { version: 2, mode: "automatic", sourceMappingEntryId: "missing" });
  if (change === "unknown-release") f.entries.push({ type: "custom", id: "release", customType: "ce-messaging-released", data: { ...f.entries[3]!.data, piSessionId: "native", intent: "other" } });
  if (change === "malformed-failure") f.entries[1]!.data.extra = true;
  expect(nativeSessionLifecycle(f.entries, "native", f.store).invalid).toBe(true);
});
it("reads exact v2 provenance and never offers another initial repair after commit", () => {
  const f = fixture(); for (const i of [2, 4]) Object.assign(f.entries[i]!.data, { version: 2, mode: "automatic", sourceMappingEntryId: "old" });
  expect(nativeSessionLifecycle(f.entries, "native", f.store)).toMatchObject({ invalid: false, mapping: f.entries[3]!.data, hasRecovery: true, initialRepairEligible: false });
});
it("detached intent persists until an ordinary exact mapping is appended", () => {
  const f = fixture(); f.entries.splice(1);
  f.entries.push({ type: "custom", id: "release", customType: "ce-messaging-released", data: { ...f.entries[0]!.data, piSessionId: "native", intent: "shutdown" } });
  expect(nativeSessionLifecycle(f.entries, "native", f.store).releaseIntent).toBe("shutdown");
  f.entries.push({ ...f.entries[0], id: "resume" });
  expect(nativeSessionLifecycle(f.entries, "native", f.store).releaseIntent).toBeUndefined();
});
it("verifies complete same-fd history and rejects unexpected same-inode appends", () => {
  const f = nativeFile(); const journal = openRecoveryJournal(f.path);
  try {
    journal.verifyHistory([f.entry], "native");
    fs.appendFileSync(f.path, JSON.stringify({ type: "custom", id: "external" }) + "\n");
    expect(() => journal.verifyHistory([f.entry], "native")).toThrow();
  } finally { journal.close(); }
});
it("rejects an undeclared SDK append visible in both memory and the native file", () => {
  const f = nativeFile();
  const manager = SessionManager.create(f.dir, join(f.dir, "unexpected"));
  manager.appendMessage({ role: "user", content: "Synthetic persistent fixture", timestamp: Date.now() });
  const journal = openRecoveryJournal(manager.getSessionFile());
  try {
    journal.verifyHistory(manager.getEntries(), manager.getSessionId());
    manager.appendCustomEntry("another-extension", { synthetic: true });
    expect(() => journal.verifyHistory(manager.getEntries(), manager.getSessionId())).toThrow();
  } finally { journal.close(); }
});
it.each(["version", "native", "extra-header", "malformed", "blank", "duplicate", "partial", "oversize"])("strict native parser refuses %s", change => {
  const f = nativeFile(); let text = fs.readFileSync(f.path, "utf8");
  if (change === "version") text = text.replace('"version":3', '"version":4');
  if (change === "native") text = text.replace('"id":"native"', '"id":"foreign"');
  if (change === "extra-header") text += text.split("\n")[0] + "\n";
  if (change === "malformed") text += "{bad}\n";
  if (change === "blank") text += "\n";
  if (change === "duplicate") text += JSON.stringify(f.entry) + "\n";
  if (change === "partial") text += "{}";
  fs.writeFileSync(f.path, text);
  if (change === "oversize") fs.truncateSync(f.path, 64 * 1024 * 1024 + 1);
  const journal = openRecoveryJournal(f.path);
  try { expect(() => journal.verifyHistory([f.entry], "native")).toThrow(); } finally { journal.close(); }
});
it("real pinned SDK branches, compaction optional undefined and reopen retain native evidence", () => {
  const f = nativeFile(); fs.unlinkSync(f.path);
  const manager = SessionManager.create(f.dir, f.dir);
  const root = manager.appendMessage({ role: "user", content: "Synthetic fixture", timestamp: Date.now() });
  const mapping = fixture().entries[0]!.data;
  manager.appendCustomEntry("ce-mapping", mapping);
  manager.branch(root);
  manager.appendCustomEntry("ce-lifecycle-blocked", { piSessionId: manager.getSessionId(), endpointId: "pi/A", code: "CE_HOST_AUTHORITY_ABSENT" });
  manager.branch(root);
  manager.appendCompaction("Synthetic summary", root, 1);
  const path = manager.getSessionFile()!; const journal = openRecoveryJournal(path);
  try {
    journal.verifyHistory(manager.getEntries(), manager.getSessionId());
    journal.verify(manager.getEntries().at(-1)!);
    const reopened = SessionManager.open(path);
    expect(reopened.getBranch().some(e => e.type === "custom")).toBe(false);
    expect(nativeSessionLifecycle(reopened.getEntries(), manager.getSessionId(), fixture().store)).toMatchObject({ invalid: false, initialRepairEligible: true });
  } finally { journal.close(); }
});
it("refuses setup-only SDK sessions and memory-visible disk-failed writes", () => {
  const f = nativeFile(); const manager = SessionManager.create(f.dir, join(f.dir, "setup"));
  manager.appendCustomEntry("ce-mapping", fixture().entries[0]!.data);
  expect(() => openRecoveryJournal(manager.getSessionFile())).toThrow();
  manager.appendMessage({ role: "user", content: "Synthetic fixture", timestamp: Date.now() });
  const journal = openRecoveryJournal(manager.getSessionFile());
  const persist = manager._persist;
  manager._persist = () => { throw new Error("synthetic disk failure"); };
  try {
    expect(() => manager.appendCustomEntry("test", {})).toThrow("synthetic disk failure");
    expect(() => journal.verifyHistory(manager.getEntries(), manager.getSessionId())).toThrow();
  } finally { manager._persist = persist; journal.close(); }
});
it("holds native header identity across entry verification", () => {
  const f = nativeFile(); const journal = openRecoveryJournal(f.path);
  try {
    journal.verifyHistory([f.entry], "native");
    fs.writeFileSync(f.path, fs.readFileSync(f.path, "utf8").replace('"id":"native"', '"id":"foreign"'));
    expect(() => journal.verify(f.entry)).toThrow();
  } finally { journal.close(); }
});
it("cannot replace verified history with a caller-visible rewritten prefix", () => {
  const f = nativeFile(); const journal = openRecoveryJournal(f.path);
  try {
    journal.verifyHistory([f.entry], "native");
    const changed = { ...f.entry, data: { identifier: "rewritten" } };
    fs.writeFileSync(f.path, fs.readFileSync(f.path, "utf8").replace(JSON.stringify(f.entry), JSON.stringify(changed)));
    expect(() => journal.verifyHistory([changed], "native")).toThrow();
  } finally { journal.close(); }
});
it("accepts only exact expected appends after a verified snapshot", () => {
  const f = nativeFile(); const journal = openRecoveryJournal(f.path);
  const next = { ...f.entry, id: "next" };
  try {
    journal.verifyHistory([f.entry], "native");
    fs.appendFileSync(f.path, JSON.stringify(next) + "\n");
    journal.verify(next);
    journal.verifyHistory([f.entry, next], "native");
    fs.truncateSync(f.path, fs.readFileSync(f.path, "utf8").indexOf(JSON.stringify(next)));
    expect(() => journal.verifyHistory([f.entry], "native")).toThrow();
  } finally { journal.close(); }
});
it("a native header id cannot be reused by an entry", () => {
  const f = nativeFile(); fs.writeFileSync(f.path, fs.readFileSync(f.path, "utf8").replace('"id":"stable"', '"id":"native"'));
  const journal = openRecoveryJournal(f.path);
  try { expect(() => journal.verifyHistory([{ ...f.entry, id: "native" }], "native")).toThrow(); } finally { journal.close(); }
});
it("verify fsyncs the held descriptor and propagates durability failure", () => {
  const f = nativeFile(); const journal = openRecoveryJournal(f.path);
  const sync = vi.mocked(fsyncSync); sync.mockClear();
  sync.mockImplementationOnce(() => { throw new Error("synthetic fsync failure"); });
  try {
    journal.verifyHistory([f.entry], "native");
    expect(sync).not.toHaveBeenCalled();
    expect(() => journal.verify(f.entry)).toThrow("synthetic fsync failure");
    expect(sync).toHaveBeenCalledOnce();
  } finally { journal.close(); }
});
it.each([undefined, "shutdown", "deactivate"])("release schema preserves detached intent %s until explicit activation", intent => {
  const f = fixture(); f.entries.splice(1);
  f.entries.push({ type: "custom", id: "release", customType: "ce-messaging-released", data: { piSessionId: "native", ...f.entries[0]!.data, ...(intent ? { intent } : {}) } });
  expect(nativeSessionLifecycle(f.entries, "native", f.store)).toMatchObject({ invalid: false, releaseIntent: intent ?? "legacy", initialRepairEligible: false });
  f.entries.push({ ...f.entries[0], id: "activation", data: { ...f.entries[0]!.data, sessionId: "activated" } });
  expect(nativeSessionLifecycle(f.entries, "native", f.store)).toMatchObject({ invalid: false, mapping: f.entries.at(-1)!.data, initialRepairEligible: false });
  expect(nativeSessionLifecycle(f.entries, "native", f.store).releaseIntent).toBeUndefined();
});
it("later failures remain unresolved after a complete native commit", () => {
  const f = fixture();
  f.entries.push({ ...f.entries[1], id: "later-failure" });
  expect(nativeSessionLifecycle(f.entries, "native", f.store)).toMatchObject({ invalid: false, hasRecovery: true, initialRepairEligible: false, failures: [f.entries.at(-1)] });
});
it.each(["different", "malformed", "missing-id"])("validates all pre-journal mappings: %s", change => {
  const f = fixture(); f.entries.splice(1);
  const next = { ...f.entries[0], id: "next", data: { ...f.entries[0]!.data } };
  if (change === "different") next.data.sessionId = "unexplained";
  if (change === "malformed") next.data.extra = true;
  if (change === "missing-id") delete (next as Record<string, unknown>).id;
  f.entries.push(next);
  expect(nativeSessionLifecycle(f.entries, "native", f.store).invalid).toBe(true);
});
