/**
 * HANDOFF-CE-RELEASE-READINESS-01 — phase 3: REAL-HOST recovery regression.
 *
 * OPT-IN LANE. This file is EXCLUDED from the default `pnpm test` selection (see
 * the `test` script in package.json) and runs only via
 * `pnpm run test:host-regression`. A missing prerequisite — or running this file
 * without the lane's opt-in variable — is a loud setup error, never a skip.
 *
 * What makes this lane different from `test/endpoints/pi/extension-lifecycle.test.ts`
 * (the unit-level C3 proof over an isolated Store harness): it drives the REAL
 * Pi 1.3.0 CLI on a REAL pseudo-terminal, so Pi's own code persists a genuine
 * session file, the CE extension writes its own `ce-mapping`, the real
 * session-process mutex is acquired by a real OS process and released by the real
 * offline reconciliation script, and the resumed generation is a live relaunch —
 * not an in-process `session_start` replay.
 *
 * Everything is synthetic and confined to a throwaway private root: a synthetic
 * SQLite Store, a synthetic loopback model provider (127.0.0.1, no credential in
 * play), a synthetic multi-session configuration published by the REAL
 * publication code, and a synthetic `chatgpt/main` peer. No real
 * Tunnel/Session/Store/Exchange, no business message, read or ACK, no Operator
 * Recovery, no network egress, and no installed `tunnel-client` execution (a
 * child_process hook refuses any execution naming it and accounts for the rest).
 *
 * Expected wall-clock: roughly 3–4 minutes plus the out-of-tree HEAD compile.
 */
import fs from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { OwnershipRow } from "./support/harness.mjs";
import {
  ENDPOINT_ID, LEASE_TTL_SECONDS, accounting, assertPrerequisites, buildFixedHead,
  captureAuthority, deathEvidence, deriveReconcileArguments, finishRun, launchMeta, piArgv, piEnvironment,
  prepareRoot, publishConfiguration, recordAssertion, restoreRegistration, revokeRegistration, runReconcile,
  setProviderDirective, sleep, startDriver, startProvider, terminalText, unreleasedSlots, waitForLease,
} from "./support/harness.mjs";

const laneEnabled = process.env.CE_HOST_REGRESSION_TEST === "1";
if (!laneEnabled) {
  throw new Error(
    "test/host-regression/real-host-recovery.test.ts is the OPT-IN real-host lane: run it with " +
      "`CE_HOST_REGRESSION_TEST=1 pnpm run test:host-regression`. It is excluded from the default " +
      "`pnpm test` on purpose (it drives a real Pi CLI on a real PTY and takes minutes). " +
      "Reaching this file without the opt-in variable is a setup error, not a skip.",
  );
}

const QUARTER_TTL_MS = (LEASE_TTL_SECONDS / 4) * 1000;
/** The TUI wraps long notifications across terminal lines and pads them with
 * run-length spaces, so every terminal-text assertion must compare against a
 * whitespace-collapsed view of the stream. */
const flat = (text: string): string => text.replace(/\s+/g, " ");
const staleHint = "operator-only stale-ownership recovery";
const mutexHint = "local session-process mutex still holds an unreleased slot";

const state: {
  paths?: ReturnType<typeof prepareRoot>;
  built?: ReturnType<typeof buildFixedHead>;
  provider?: Awaited<ReturnType<typeof startProvider>>;
  driver?: ReturnType<typeof startDriver>;
  publication?: Awaited<ReturnType<typeof publishConfiguration>>;
  firstPid?: number;
  recoveredPid?: number;
  preKillOwnership?: OwnershipRow | undefined;
  adoptedOwnership?: OwnershipRow | undefined;
  adoptedRemainingSeconds?: number | undefined;
  recoveredCeSession?: string | undefined;
  fencingToken?: number | undefined;
} = {};
let failed = false;
let reachedEnd = false;
afterEach(({ task }) => { if (task.result?.state === "fail") failed = true; });

function check(id: string, detail: string, evidence: string, verify: () => void) {
  try {
    verify();
    recordAssertion(state.paths!, id, "PASS", detail, evidence);
  } catch (error) {
    recordAssertion(state.paths!, id, "FAIL", `${detail}: ${error instanceof Error ? error.message : String(error)}`, evidence);
    throw error;
  }
}

beforeAll(() => {
  assertPrerequisites();
  state.paths = prepareRoot();
  // The scenario log is the first thing an operator reads; keep it beside the evidence.
  fs.writeFileSync(join(state.paths.raw, "scenario-root.txt"), `${state.paths.root}\n`);
}, 60_000);

// Await owned-process reaping and provider closure before any fixture deletion.
afterAll(async () => {
  await finishRun(state.paths, state.driver, state.provider, {
    successful: reachedEnd && !failed,
    keep: process.env.CE_HOST_REGRESSION_KEEP === "1",
  });
}, 60_000);

describe("REAL-HOST crash recovery closure (opt-in lane, synthetic Store)", () => {
  it("builds HEAD out-of-tree and proves the tested artifact is the committed HEAD", () => {
    state.built = buildFixedHead(state.paths!);
    const identity = state.built.identity;
    check("build.head", "out-of-tree git-archive compile of HEAD with a clean build log", "raw/build.log", () => {
      expect(identity.compared).toBe(identity.tracked);
      expect(identity.mismatches).toEqual([]);
      expect(identity.missing).toEqual([]);
      expect(identity.extra).toEqual([]);
      expect(fs.readFileSync(join(state.paths!.raw, "build.log"), "utf8")).toBe("");
    });
    check("build.identity", "HEAD blob identities match the extract; no build-consumed source differs from HEAD", "raw/identity.json", () => {
      expect(identity.head).toMatch(/^[0-9a-f]{40}$/);
      // The lane always tests HEAD, never the working tree. That is only honest
      // when the product sources the build consumes are themselves unmodified:
      // an edited src/ with an unmodified extract would silently test the wrong
      // thing. Test and documentation edits are deliberately allowed here.
      expect(identity.dirtySources).toBe("");
    });
  }, 240_000);

  it("publishes the synthetic multi-session configuration with the real publication code", async () => {
    state.provider = await startProvider(state.paths!);
    state.publication = await publishConfiguration(state.paths!, state.built!);
    setProviderDirective(state.paths!, { mode: "text" });
    check("config.published", "one active registration pi/hr-A <- hr-A; synthetic Store not yet created", "raw/authority-01-published.json", () => {
      expect(state.publication!.registrations).toEqual([
        { endpointId: ENDPOINT_ID, runtimeSessionId: "hr-A", payloadRead: false, ack: false, epoch: 1, status: "active" },
      ]);
      const before = captureAuthority(state.paths!, "01-published");
      expect(before.store.exists).toBe(false);
    });
  }, 120_000);

  it("persists a genuine native session through Pi's own code and binds the endpoint", async () => {
    state.driver = startDriver(state.paths!);
    const environment = piEnvironment(state.paths!);
    state.driver.launch("02-persisted-bound", piArgv(state.paths!, state.built!), environment, state.paths!.cwd, 8);
    state.firstPid = launchMeta(state.paths!, "02-persisted-bound").pid;
    const bound = await state.driver.waitFor("02-persisted-bound",
      (text) => (text.includes(`endpoint ${ENDPOINT_ID} bound (participant `) ? "bound" : undefined), 45_000, "initial bind");
    check("persist.bind", "real host bound the multi-session endpoint at session start", "raw/02-persisted-bound.txt", () => {
      expect(flat(bound.text)).toContain(`ce-chat-exchange: endpoint ${ENDPOINT_ID} bound (participant prt_`);
    });
    // A real user prompt makes Pi's SessionManager persist the session file.
    state.driver.send("Synthetic offline persistence marker; no CE operation requested.\r", 6);
    await state.driver.waitFor("02-persisted-bound",
      (text) => (text.includes("synthetic offline acknowledgement") ? "answered" : undefined), 45_000, "synthetic model answer");
    const snapshot = captureAuthority(state.paths!, "02-persisted-bound");
    const session = snapshot.piSessions.files.find((file) => file.name.endsWith("hr-A.jsonl"));
    check("persist.session", "Pi's own code persisted a session file with a real user message and the extension's ce-mapping", "raw/authority-02-persisted-bound.json", () => {
      expect(session?.hasUserMessage).toBe(true);
      expect(session?.ceEntries?.map((entry) => entry.customType)).toContain("ce-mapping");
    });
    const ownership = snapshot.ownership?.[0];
    state.preKillOwnership = ownership;
    state.recoveredCeSession = ownership?.session_id;
    state.fencingToken = ownership?.fencing_token;
    check("persist.authority", "durable owner row ACTIVE with fencing token 1 and one unreleased mutex slot", "raw/authority-02-persisted-bound.json", () => {
      expect(snapshot.leaseEvaluation?.[0]?.lease).toBe("ACTIVE");
      expect(ownership?.fencing_token).toBe(1);
      expect(unreleasedSlots(snapshot)).toHaveLength(1);
    });
  }, 180_000);

  it("SIGKILL leaves the durable owner attached, the lease live and the mutex slot unreleased", () => {
    state.driver!.kill();
    const death = deathEvidence(state.paths!, state.firstPid!, "02-persisted-bound");
    check("kill.evidence", "independent ps evidence that the killed PID no longer exists", `raw/death-02-persisted-bound.json`, () => {
      expect(death.definitive).toBe(true);
      expect(death.psStatus).toBe(1);
    });
    const snapshot = captureAuthority(state.paths!, "03-post-kill");
    check("kill.state", "no CE release happened: owner still ATTACHED, lease still ACTIVE, slot still unreleased", "raw/authority-03-post-kill.json", () => {
      expect(snapshot.leaseEvaluation?.[0]?.lease).toBe("ACTIVE");
      expect(snapshot.sessionsBound?.some((row) => row.session_id === state.recoveredCeSession && row.detached_at === null)).toBe(true);
      expect(unreleasedSlots(snapshot)).toHaveLength(1);
      expect(snapshot.ownership?.[0]).toEqual(state.preKillOwnership);
    });
  }, 60_000);

  it("refuses a relaunch inside the lease window through the local mutex, with the slot count unchanged", async () => {
    state.driver!.launch("04-mutex-refusal", piArgv(state.paths!, state.built!), piEnvironment(state.paths!), state.paths!.cwd, 10);
    const refusal = await state.driver!.waitFor("04-mutex-refusal",
      (text) => (text.includes("session start failed closed") ? text : undefined), 45_000, "mutex refusal");
    const snapshot = captureAuthority(state.paths!, "04-mutex-refusal");
    check("mutex.surface", "CE_HOST_UNAVAILABLE with the documented mutex hint and NO stale-ownership hint", "raw/04-mutex-refusal.txt", () => {
      expect(flat(refusal.text)).toContain("session start failed closed (CE_HOST_UNAVAILABLE)");
      expect(flat(refusal.text)).toContain(flat(mutexHint));
      expect(flat(refusal.text)).not.toContain(flat(staleHint));
      expect(flat(refusal.text)).not.toContain("CE_HOST_AUTHORITY_ABSENT / ");
    });
    check("mutex.slots", "the refused relaunch claimed no new slot and left the durable lease untouched", "raw/authority-04-mutex-refusal.json", () => {
      expect(snapshot.mutex?.scopes?.[0]?.slots).toHaveLength(1);
      expect(snapshot.leaseEvaluation?.[0]?.lease).toBe("ACTIVE");
      expect(snapshot.ownership?.[0]).toEqual(state.preKillOwnership);
    });
    state.driver!.send("/quit\r", 0);
    const reaped = state.driver!.awaitExit();
    check("reconcile.currentLaunch", "the CURRENT refused launch positively exited and was reaped before the offline window", "raw/04-mutex-refusal.meta.json", () => {
      expect(reaped.name).toBe("04-mutex-refusal");
      expect(reaped.pid).toBe(launchMeta(state.paths!, "04-mutex-refusal").pid);
      expect(reaped.reaped).toBe(true);
      expect(reaped).toMatchObject({ groupDead: true, anchorReaped: true, confirmed: true, driverLost: false });
      expect(reaped.anchorPid).not.toBe(reaped.pid);
      expect(reaped.pgid).toBe(reaped.anchorPid);
      expect(reaped.events).toEqual(["final-group-kill", "no-live-members", "anchor-reaped"]);
      expect(reaped.exit).toBe(0);
    });
  }, 120_000);

  it("reconciles the local mutex offline with every documented expect flag and independent death evidence", async () => {
    const before = captureAuthority(state.paths!, "05-pre-reconcile");
    const death = deathEvidence(state.paths!, state.firstPid!, "reconcile");
    check("reconcile.window", "offline window prerequisite: the owner is definitively dead and exactly one slot is unreleased", "raw/death-reconcile.json", () => {
      expect(death.definitive).toBe(true);
      expect(unreleasedSlots(before)).toHaveLength(1);
    });
    const argv = deriveReconcileArguments(before, state.publication!.store,
      `ps -p ${state.firstPid} exit=1 empty-output at ${death.at}; harness SIGKILL (raw/death-02-persisted-bound.json, raw/02-persisted-bound.meta.json)`);
    const result = runReconcile(state.paths!, state.built!, argv, "reconcile-first", state.driver!);
    check("reconcile.offlineThroughout", "no Store-capable owned process exists at either end of the serialized offline window", "raw/reconcile-first.json", () => {
      expect(result.offlineBefore.name).toBe("04-mutex-refusal");
      expect(result.offlineBefore.reaped).toBe(true);
      expect(result.offlineBefore).toMatchObject({ groupDead: true, anchorReaped: true, confirmed: true, driverLost: false });
      expect(result.offlineAfter).toEqual(result.offlineBefore);
    });
    check("reconcile.exit", "documented reconcile script exits 0 with its fixed success line and empty stderr", "raw/reconcile-first.json", () => {
      expect(argv).toHaveLength(39);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("local mutex receipt reconciled; no CE authority or business resumption authorized");
    });
    const after = captureAuthority(state.paths!, "06-post-reconcile");
    check("reconcile.state", "receipt bytes equal owner bytes; ownership untouched by reconciliation", "raw/authority-06-post-reconcile.json", () => {
      const slot = after.mutex?.scopes?.[0]?.slots?.[0];
      expect(slot?.released).toBe(true);
      expect(slot?.receiptEqualsOwner).toBe(true);
      expect(after.ownership?.[0]).toEqual(state.preKillOwnership);
      expect(after.leaseEvaluation?.[0]?.lease).toBe("ACTIVE");
    });
  }, 120_000);

  it("resumes inside the lease window: same CE session, fencing unchanged, no takeover", async () => {
    // The discriminating C3 window: relaunch only when the ADOPTED term has less
    // than a quarter of the TTL left, which is exactly the case the unit test
    // characterizes and the pre-fix heartbeat got wrong.
    const { lease } = await waitForLease(state.paths!, (row) => row.lease === "ACTIVE" && row.secondsRemaining <= 13 && row.secondsRemaining > 4,
      90_000, "adopted term below TTL/4");
    state.adoptedRemainingSeconds = lease.secondsRemaining;
    state.adoptedOwnership = captureAuthority(state.paths!, "07-immediately-before-resume").ownership?.[0];
    state.driver!.launch("08-resumed", piArgv(state.paths!, state.built!), piEnvironment(state.paths!), state.paths!.cwd, 10);
    const resumed = await state.driver!.waitFor("08-resumed",
      (text) => (text.includes(`endpoint ${ENDPOINT_ID} bound (participant `) ? text : undefined), 45_000, "resumed bind");
    state.recoveredPid = launchMeta(state.paths!, "08-resumed").pid;
    const after = captureAuthority(state.paths!, "08-resumed");
    check("resume.adoptedTerm", "the adopted term really was shorter than TTL/4 when the resumed generation started", "raw/authority-07-immediately-before-resume.json", () => {
      expect(state.adoptedRemainingSeconds!).toBeLessThan(LEASE_TTL_SECONDS / 4);
    });
    check("resume.sameSession", "the SAME CE session was resumed, not a new incarnation", "raw/08-resumed.txt", () => {
      expect(flat(resumed.text)).toContain(`session ${state.recoveredCeSession}`);
      expect(after.ownership?.[0]?.session_id).toBe(state.recoveredCeSession);
      expect(after.sessionsBound?.filter((row) => row.session_id === state.recoveredCeSession && row.detached_at === null)).toHaveLength(1);
    });
    check("resume.fencing", "fencing token unchanged and high-water equal: no takeover, no new generation", "raw/authority-08-resumed.json", () => {
      expect(after.ownership?.[0]?.fencing_token).toBe(state.fencingToken);
      expect(after.fencingHighWater?.[0]?.fencing_token).toBe(state.fencingToken);
    });
    check("resume.noNewParticipant", "no second participant or ownership row appeared", "raw/authority-08-resumed.json", () => {
      expect(after.participants).toHaveLength(1);
      expect(after.ownership).toHaveLength(1);
    });
  }, 180_000);

  it("renews the adopted lease inside its remaining term with no fail-closed latch (the live C3 proof)", async () => {
    const adoptedExpiry = Date.parse(String(state.adoptedOwnership!.expires_at));
    expect(Number.isFinite(adoptedExpiry)).toBe(true);
    // The pre-fix behaviour failed closed at the first TTL/4 tick. Waiting well
    // past both the adopted expiry and the TTL/4 tick discriminates the fix.
    const deadline = Date.now() + QUARTER_TTL_MS + 15_000;
    let renewed: ReturnType<typeof captureAuthority> | undefined;
    while (Date.now() < deadline) {
      const snapshot = captureAuthority(state.paths!, `08-renew-poll`);
      const ownership = snapshot.ownership?.[0];
      if (ownership && Date.parse(String(ownership.expires_at)) > adoptedExpiry
        && Number(ownership.private_revision) > Number(state.adoptedOwnership!.private_revision)) { renewed = snapshot; break; }
      await sleep(1_000);
    }
    const renewedOwnership = renewed?.ownership?.[0];
    check("renew.observed", "participant_ownership.expires_at strictly increased while bound", "raw/authority-08-renew-poll.json", () => {
      expect(renewedOwnership).toBeDefined();
      expect(Date.parse(String(renewedOwnership!.expires_at))).toBeGreaterThan(adoptedExpiry);
    });
    check("renew.insideTerm", "the renewal landed BEFORE the adopted term would have expired", "raw/authority-08-renew-poll.json", () => {
      expect(Date.parse(String(renewedOwnership!.lease_started_at))).toBeLessThan(adoptedExpiry + 1_000);
    });
    check("renew.revision", "renewal bumped private_revision, kept fencing and the same session", "raw/authority-08-renew-poll.json", () => {
      expect(Number(renewedOwnership!.private_revision)).toBeGreaterThan(Number(state.adoptedOwnership!.private_revision));
      expect(renewedOwnership!.fencing_token).toBe(state.fencingToken);
      expect(renewedOwnership!.session_id).toBe(state.recoveredCeSession);
    });
    await sleep(5_000);
    const text = terminalText(state.paths!, "08-resumed");
    const session = captureAuthority(state.paths!, "08-no-latch").piSessions.files.find((file) => file.name.endsWith("hr-A.jsonl"));
    check("renew.noLatch", "no lifecycle fail-closed and no ce-lifecycle-blocked entry after the adopted term", "raw/08-resumed.txt", () => {
      expect(flat(text)).not.toContain("lifecycle failed closed");
      expect(session?.ceEntries?.map((entry) => entry.customType)).not.toContain("ce-lifecycle-blocked");
    });
  }, 180_000);

  it("completes an authorized local routing operation after recovery (the closure assertion)", async () => {
    const before = captureAuthority(state.paths!, "09-before-send");
    const priorMessages = before.messages?.length ?? 0;
    const priorAudit = before.auditEvents?.length ?? 0;
    setProviderDirective(state.paths!, { mode: "tool", tool: "ce_send",
      args: { to: "chatgpt/main", text: "authorized synthetic routing operation after recovery", idempotencyKey: "hr-recovery-closure-001" } });
    state.driver!.send("Perform the authorized local routing operation now.\r", 6);
    const sent = await state.driver!.waitFor("08-resumed",
      (text) => (text.includes("chat-exchange created: message msg_") ? text : text.includes("chat-exchange refused") ? text : undefined),
      45_000, "authorized ce_send");
    const after = captureAuthority(state.paths!, "09-after-send");
    const message = after.messages?.find((row) => row.idempotency_key === "hr-recovery-closure-001");
    check("send.toolResult", "ce_send returned a messageId to the real host", "raw/08-resumed.txt", () => {
      expect(flat(sent.text)).toContain("chat-exchange created: message msg_");
      expect(flat(sent.text)).toContain("to chatgpt/main (audit #");
    });
    check("send.messageRow", "a NEW durable message row exists under the resumed CE session's exchange", "raw/authority-09-after-send.json", () => {
      expect(after.messages?.length).toBe(priorMessages + 1);
      expect(message).toMatchObject({ recipient: "chatgpt/main", state: "CREATED" });
    });
    check("send.auditRow", "the message's audit_event row appeared in the same Store", "raw/authority-09-after-send.json", () => {
      expect(after.auditEvents?.length).toBeGreaterThan(priorAudit);
      expect(after.auditEvents?.some((row) => row.subject_id === message?.message_id)).toBe(true);
    });
    setProviderDirective(state.paths!, { mode: "text" });
  }, 120_000);

  it("refuses the same operation when the admission policy is narrowed mid-flight", async () => {
    await revokeRegistration(state.publication!);
    const narrowed = captureAuthority(state.paths!, "10-after-revoke");
    check("narrow.published", "the registration is now revoked in the published generation", "raw/authority-10-after-revoke.json", () => {
      expect(narrowed.bindings?.entries?.flatMap((entry) => entry.registrations ?? [])
        .some((row) => row.endpointId === ENDPOINT_ID && row.status === "revoked")).toBe(true);
    });
    setProviderDirective(state.paths!, { mode: "tool", tool: "ce_send",
      args: { to: "chatgpt/main", text: "must be refused after narrowing", idempotencyKey: "hr-narrowed-001" } });
    state.driver!.send("Perform the routing operation again.\r", 6);
    const refused = await state.driver!.waitFor("08-resumed",
      (text) => (text.includes("chat-exchange refused: CE_HOST_AUTHORITY_ABSENT") ? text : undefined), 60_000, "narrowed ce_send refusal");
    const after = captureAuthority(state.paths!, "10-refused");
    check("narrow.reason", "the refusal carries ADMISSION_POLICY_DENIED, not only the code", "raw/08-resumed.txt", () => {
      expect(flat(refused.text)).toContain("chat-exchange refused: CE_HOST_AUTHORITY_ABSENT (ADMISSION_POLICY_DENIED)");
    });
    check("narrow.noWrite", "no new message or audit row was written by the refused operation", "raw/authority-10-refused.json", () => {
      expect(after.messages).toEqual(narrowed.messages);
      expect(after.auditEvents).toEqual(narrowed.auditEvents);
    });
    setProviderDirective(state.paths!, { mode: "text" });
    // Deliberately NO clean shutdown: the next step SIGKILLs this process so its
    // own mutex slot is unreleased and needs its own offline reconciliation.
  }, 120_000);

  it("an expired owner fails closed with the EXPIRED reason, a new mutex slot and byte-identical ownership", async () => {
    // The narrowing above left this runtime Session unregistered, which would
    // stop the extension before any CE check ("not in the allowlist"). Restore
    // admission for a FRESH process by publishing the next epoch; the already
    // running process keeps its captured (denied) epoch and stays denied.
    await restoreRegistration(state.publication!);
    const restored = captureAuthority(state.paths!, "11-admission-restored");
    check("expired.readmitted", "a fresh process sees an active registration again at the next epoch", "raw/authority-11-admission-restored.json", () => {
      const active = restored.bindings.entries.flatMap((entry) => entry.registrations ?? [])
        .filter((row) => row.endpointId === ENDPOINT_ID && row.status === "active");
      expect(active.length).toBeGreaterThan(0);
      expect(Math.max(...active.map((row) => row.epoch))).toBeGreaterThan(1);
    });
    const killedAt = captureAuthority(state.paths!, "11-final-pre-kill");
    const expiresAt = Date.parse(String(killedAt.ownership?.[0]?.expires_at));
    const finalOwnership = killedAt.ownership?.[0];
    state.driver!.kill();
    const death = deathEvidence(state.paths!, state.recoveredPid!, "final");
    check("expired.window", "the recovered process is dead by SIGKILL, so its own mutex slot is unreleased", "raw/death-final.json", () => {
      expect(death.definitive).toBe(true);
      expect(death.psStatus).toBe(1);
    });
    const expired = await waitForLease(state.paths!, (row) => row.lease === "EXPIRED", 150_000, "durable lease expiry");
    check("expired.observed", "the durable lease was observed EXPIRED before the refused relaunch", "raw/authority-poll.json", () => {
      expect(expired.lease.lease).toBe("EXPIRED");
      expect(Date.now()).toBeGreaterThan(expiresAt);
    });
    const reaped = state.driver!.awaitExit();
    expect(reaped.pid).toBe(state.recoveredPid);
    const slotTwo = captureAuthority(state.paths!, "12-lease-expired");
    const argv = deriveReconcileArguments(slotTwo, state.publication!.store,
      `ps -p ${state.recoveredPid} exit=1 empty-output at ${death.at}; harness SIGKILL (raw/death-final.json, raw/08-resumed.meta.json)`);
    const result = runReconcile(state.paths!, state.built!, argv, "reconcile-second", state.driver!);
    check("expired.offlineThroughout", "the exact recovered launch is reaped throughout the second offline window", "raw/reconcile-second.json", () => {
      expect(result.offlineBefore).toEqual(reaped);
      expect(result.offlineBefore.name).toBe("08-resumed");
      expect(result.offlineBefore).toMatchObject({ groupDead: true, anchorReaped: true, confirmed: true, driverLost: false });
      expect(result.offlineBefore.events).toEqual(["final-group-kill", "no-live-members", "anchor-reaped"]);
      expect(result.offlineAfter).toEqual(reaped);
    });
    check("expired.reconcile", "the recovered process's own slot was reconciled the same documented way", "raw/reconcile-second.json", () => {
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("local mutex receipt reconciled");
    });
    state.driver!.launch("13-expired-refusal", piArgv(state.paths!, state.built!), piEnvironment(state.paths!), state.paths!.cwd, 10);
    const refused = await state.driver!.waitFor("13-expired-refusal",
      (text) => (text.includes("session start failed closed") ? text : undefined), 45_000, "expired-owner refusal");
    const after = captureAuthority(state.paths!, "13-expired-refusal");
    const ownershipAfter = after.ownership?.[0];
    check("expired.reason", "the session-start surface names the advisory EXPIRED reason (C1)", "raw/13-expired-refusal.txt", () => {
      expect(flat(refused.text)).toContain("session start failed closed (CE_HOST_AUTHORITY_ABSENT / EXPIRED)");
    });
    check("expired.hint", "the C2 stale-ownership hint appears for the authorized reason only", "raw/13-expired-refusal.txt", () => {
      expect(flat(refused.text)).toContain(flat(staleHint));
      expect(flat(refused.text)).toContain("no automatic recovery and no takeover");
      expect(flat(refused.text)).not.toContain(flat(mutexHint));
    });
    check("expired.newSlot", "a NEW mutex slot was claimed before the CE refusal (the mutex was not the blocker)", "raw/authority-13-expired-refusal.json", () => {
      expect(after.mutex?.scopes?.[0]?.slots?.length).toBeGreaterThan(slotTwo.mutex?.scopes?.[0]?.slots?.length ?? 0);
    });
    check("expired.byteIdentical", "the durable ownership row is byte-identical: no takeover, no adoption, no repair", "raw/authority-13-expired-refusal.json", () => {
      expect(ownershipAfter?.session_id).toBe(finalOwnership?.session_id);
      expect(ownershipAfter?.fencing_token).toBe(finalOwnership?.fencing_token);
      expect(ownershipAfter?.expires_at).toBe(finalOwnership?.expires_at);
      expect(ownershipAfter?.private_revision).toBe(finalOwnership?.private_revision);
    });
    check("expired.noLatchEntry", "this refusal is the authority-absent path, not the persisted lifecycle latch", "raw/authority-13-expired-refusal.json", () => {
      const session = after.piSessions.files.find((file) => file.name.endsWith("hr-A.jsonl"));
      expect(flat(refused.text)).not.toContain("lifecycle failed closed");
      expect(session?.ceEntries?.map((entry) => entry.customType)).not.toContain("ce-lifecycle-blocked");
    });
  }, 300_000);

  it("surfaces the same reason on the explicit activation surface (C1 on both operator surfaces)", async () => {
    state.driver!.send("/ce-tunnel activate\r", 8);
    const activated = await state.driver!.waitFor("13-expired-refusal",
      (text) => (text.includes("ce-tunnel: activation refused") ? text : undefined), 45_000, "activation refusal");
    check("activation.reason", "explicit activation names the same domain reason", "raw/13-expired-refusal.txt", () => {
      expect(flat(activated.text)).toContain("ce-tunnel: activation refused CE_HOST_AUTHORITY_ABSENT / EXPIRED; no automatic retry or takeover");
    });
    check("activation.hint", "the stale-ownership hint appears here too, and only for the authorized reason", "raw/13-expired-refusal.txt", () => {
      expect(flat(activated.text)).toContain(flat(staleHint));
      expect(flat(activated.text)).not.toContain(flat(mutexHint));
    });
    state.driver!.send("/quit\r", 0);
    const reaped = state.driver!.awaitExit();
    check("activation.reaped", "the final Store-capable launch exited and was reaped before accounting/teardown", "raw/13-expired-refusal.meta.json", () => {
      expect(reaped.name).toBe("13-expired-refusal");
      expect(reaped.pid).toBe(launchMeta(state.paths!, "13-expired-refusal").pid);
      expect(reaped.reaped).toBe(true);
      expect(reaped.exit).toBe(0);
    });
  }, 120_000);

  it("accounts for every child process and proves zero tunnel-client executions", () => {
    check("accounting.allReaped", "all four Store-capable owned launches were positively reaped", "raw/*.meta.json", () => {
      for (const name of ["02-persisted-bound", "04-mutex-refusal", "08-resumed", "13-expired-refusal"]) {
        const meta = launchMeta(state.paths!, name);
        expect(meta.cleanup).toMatchObject({ name, pid: meta.pid, reaped: true, exit: meta.exit,
          groupDead: true, anchorReaped: true, confirmed: true, driverLost: false });
      }
    });
    const summary = accounting(state.paths!);
    check("accounting.zeroClient", "no child_process call in the whole host tree named tunnel-client", "raw/process-accounting-summary.json", () => {
      expect(summary.tunnelClientExecutions).toBe(0);
      expect(summary.unsupportedEscapes).toBe(0);
    });
    check("accounting.recorded", "the hook observed real child_process activity (the accounting is live, not vacuous)", "raw/process-accounting-summary.json", () => {
      expect(summary.total).toBeGreaterThan(0);
    });
  }, 60_000);

  it("records the assertion ledger in the original evidence root", () => {
    const ledger = fs.existsSync(state.paths!.assertions) ? fs.readFileSync(state.paths!.assertions, "utf8") : "";
    const rows = ledger.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { id: string; status: string });
    fs.writeFileSync(join(state.paths!.raw, "ledger.json"), JSON.stringify(rows, null, 2));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.status === "PASS")).toBe(true);
    // Teardown prints the actual retained path only if KEEP or failure applies.
    reachedEnd = true;
  }, 60_000);
});
