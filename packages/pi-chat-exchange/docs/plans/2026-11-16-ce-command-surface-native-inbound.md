# CE Command Surface and Native Inbound Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Consolidate ordinary CE operations under `/ce`, add safe current-Session native inbound activation, retain hidden legacy compatibility, and verify a standard npm installation with a fresh Pi Session.

**Architecture:** Add a small policy-management boundary beside `native-inbound.ts`, then make the existing extension factory route the new `/ce` subcommands to existing handlers. Keep the old command registrations as compatibility shims. Compose status from existing evidence sources and report unverifiable fields as `UNKNOWN`; do not change Store, protocol, ownership, or Tunnel lifecycle.

**Tech Stack:** TypeScript, Pi 1.3.0 extension API, Vitest, Node filesystem primitives, existing CE Host/Tunnel services.

---

### Task 1: Native inbound policy-management boundary

**Files:**
- Create: `packages/pi-chat-exchange/pi-extension/native-inbound-policy.ts`
- Test: `packages/pi-chat-exchange/test/endpoints/pi/native-inbound-policy.test.ts`

**Step 1: Write failing policy tests**

Cover status for missing/enabled/disabled/invalid files, closed `--from` parsing,
current identity validation, high-water preservation, mode `0700`/`0600`, atomic
replacement, symlink/hardlink refusal, enable with current time/audit boundary,
and disable retaining all fields except `enabled`.

**Step 2: Verify RED**

Run:

```bash
mise exec node@24.21.0 -- pnpm --filter @zieglar/pi-chat-exchange exec vitest run test/endpoints/pi/native-inbound-policy.test.ts
```

Expected: FAIL because `native-inbound-policy.ts` does not exist.

**Step 3: Implement the boundary**

Export typed operations to:

- resolve the default per-Session path;
- inspect a policy without mutation;
- atomically enable from a caller-supplied verified identity, sender, audit
  high-water and current time;
- atomically disable only a matching current-Session policy.

Reuse the existing strict policy validation rules. Validate unknown command input
once before passing typed values inward. Use same-directory exclusive temporary
creation, `fsync`, `rename`, directory sync and post-write verification. Never
accept symlinks, multiple links, unsafe ownership or unsafe modes.

**Step 4: Verify GREEN**

Run the Task 1 command. Expected: PASS.

**Step 5: Commit**

```bash
git add packages/pi-chat-exchange/pi-extension/native-inbound-policy.ts packages/pi-chat-exchange/test/endpoints/pi/native-inbound-policy.test.ts
git commit -m "feat(pi-chat-exchange): manage native inbound policy safely"
```

### Task 2: Unified `/ce` routing and hidden compatibility shims

**Files:**
- Modify: `packages/pi-chat-exchange/pi-extension/index.ts`
- Test: `packages/pi-chat-exchange/test/endpoints/pi/extension-command-surface.test.ts`

**Step 1: Write failing routing tests**

Characterize all legacy handlers first, then require:

- visible `/ce` completion for `status`, `setup`, `session`, `inbound`, and
  `advanced` only;
- exact nested completion for the approved tree;
- `/ce` no-argument status/manager behavior;
- delegation to existing setup, activate/deactivate/sessions, Tunnel, Native,
  Hook and runtime-binding handlers;
- legacy commands still execute the same handlers but do not advertise duplicate
  ordinary descriptions/completions;
- invalid and incomplete routes fail read-only with help.

**Step 2: Verify RED**

Run:

```bash
mise exec node@24.21.0 -- pnpm --filter @zieglar/pi-chat-exchange exec vitest run test/endpoints/pi/extension-command-surface.test.ts
```

Expected: FAIL because `/ce` does not implement the new tree.

**Step 3: Implement minimal routing**

Move reusable command bodies into nearby closures without changing their
behavior. Register `/ce` as the only ordinary entry point. Keep old registrations
as direct compatibility shims with compatibility descriptions and no public
argument completions. Route live `session bind|unbind|list` to existing
activation/deactivation/list paths, not to new authority logic.

**Step 4: Verify GREEN**

Run Task 2 tests plus existing multi-session, live-connect, messaging-activation,
hooks and runtime-binding tests with `--testTimeout=15000`. Expected: PASS.

**Step 5: Commit**

```bash
git add packages/pi-chat-exchange/pi-extension/index.ts packages/pi-chat-exchange/test/endpoints/pi/extension-command-surface.test.ts
git commit -m "feat(pi-chat-exchange): unify user command entry"
```

### Task 3: Inbound command lifecycle and consolidated status

**Files:**
- Modify: `packages/pi-chat-exchange/pi-extension/index.ts`
- Modify: `packages/pi-chat-exchange/pi-extension/native-inbound.ts`
- Test: `packages/pi-chat-exchange/test/endpoints/pi/extension-command-surface.test.ts`
- Test: `packages/pi-chat-exchange/test/endpoints/pi/extension-multi-session.test.ts`

**Step 1: Write failing behavior tests**

Require `inbound status|enable|disable` to:

- refuse mutation outside real TUI confirmation;
- require explicit `--from` on enable;
- capture current admitted Session/Endpoint/Exchange and current audit high-water;
- revalidate identity, profile and high-water after confirmation;
- atomically write only the current Session policy;
- require explicit Pi reload for adoption;
- disable without deleting history or changing Owner;
- reload with one native controller and admit only a fresh post-boundary message.

Require consolidated status to show Session, Owner, Tunnel, Native, inbound and
MCP source, using `UNKNOWN` for evidence that cannot be obtained.

**Step 2: Verify RED**

Run the two test files. Expected: FAIL on missing routes/status fields.

**Step 3: Implement minimal integration**

Use `getHost().status()` and bounded inbox discovery to capture current
authority and audit high-water without adding Store APIs. Invoke the Task 1
policy manager only after confirmation and post-confirmation revalidation.
Compose status from existing readiness and manager observations; contain each
independent observation failure and render `UNKNOWN`. Do not infer the MCP
source when no supported local observation exists.

**Step 4: Verify GREEN**

Run Task 3 tests plus `native-inbound.test.ts`. Expected: PASS.

**Step 5: Commit**

```bash
git add packages/pi-chat-exchange/pi-extension/index.ts packages/pi-chat-exchange/pi-extension/native-inbound.ts packages/pi-chat-exchange/test/endpoints/pi/extension-command-surface.test.ts packages/pi-chat-exchange/test/endpoints/pi/extension-multi-session.test.ts
git commit -m "feat(pi-chat-exchange): activate inbound through ce command"
```

### Task 4: Correct live help and package documentation

**Files:**
- Modify: `packages/pi-chat-exchange/pi-extension/index.ts`
- Modify: `packages/pi-chat-exchange/pi-extension/README.md`
- Modify: `packages/pi-chat-exchange/pi-extension/README.zh-CN.md`
- Modify: `packages/pi-chat-exchange/docs/native-inbound.md`
- Modify: `packages/pi-chat-exchange/docs/tunnel-setup.md`
- Test: `packages/pi-chat-exchange/test/endpoints/pi/extension-command-surface.test.ts`

**Step 1: Add failing exact-copy tests**

Assert live descriptions say connect may reuse shared transport, disconnect
retains it, and register only publishes current-Session policy. Assert legacy
differences remain explicitly labelled.

**Step 2: Verify RED**

Run the command-surface test. Expected: FAIL on old copy.

**Step 3: Update copy and docs**

Document the canonical `/ce` tree and mark old commands compatibility-only.
Replace manual inbound-file creation as the ordinary path with `/ce inbound`,
while retaining the file contract as advanced diagnostic documentation.

**Step 4: Verify GREEN and docs consistency**

Run the command test, `pnpm --filter @zieglar/pi-chat-exchange run typecheck`,
and `git diff --check`. Expected: PASS.

**Step 5: Commit**

```bash
git add packages/pi-chat-exchange/pi-extension packages/pi-chat-exchange/docs
git commit -m "docs(pi-chat-exchange): document canonical ce commands"
```

### Task 5: Candidate verification

**Files:** No new production files unless a test exposes a defect.

**Step 1: Run targeted affected tests**

Run all tests named in Tasks 1–4 under Node 24.21.0 with a 15-second timeout.
Expected: PASS.

**Step 2: Run package verification**

Run:

```bash
mise exec node@24.21.0 -- pnpm --filter @zieglar/pi-chat-exchange run check
mise exec node@24.21.0 -- pnpm --filter @zieglar/pi-chat-exchange run typecheck
mise exec node@24.21.0 -- pnpm --filter @zieglar/pi-chat-exchange run build
mise exec node@24.21.0 -- pnpm --filter @zieglar/pi-chat-exchange test
```

Expected: PASS. Preserve and report any first failure before rerun.

**Step 3: Inspect fixed diff and runtime identity**

Record branch, HEAD, status, changed files and candidate package identity. Confirm
no unrelated files or production configuration entered the commits.

### Task 6: Standard npm adoption and fresh-Session production acceptance

**Files outside repository:**
- Modify through Pi only: `~/.pi/agent/settings.json`
- Create through CE command only: current Session inbound policy

**Step 1: Re-audit production baseline**

Verify Pi version/processes, Tunnel PID, MCP PID/source, startup budget, current
settings, Store health and current Owner. Stop on drift affecting safety.

**Step 2: Adopt standard npm source**

Run `pi install npm:@zieglar/pi-chat-exchange@0.3.5` through Pi's supported
installer. Remove the manual CE package entry only through supported package
management, verify exactly one CE source remains, and verify the installed
artifact identity. Do not update or restart MCP.

**Step 3: Start a fresh Pi Session**

Do not reuse the old Owner or policy. Use the existing supported live
registration/reload/activation flow without calling Tunnel start. Verify the new
Endpoint and Owner, then run `/ce inbound enable --from chatgpt/main` and reload
Pi locally.

**Step 4: Declare READY**

Report the exact new Endpoint and request one new test message. Do not replay or
read messages 395/396.

**Step 5: Capture genuine acceptance evidence**

Observe the new message's durable CREATED event, `ce-inbound-wake`, native turn,
`ce-inbound-receive` STARTED/RETURNED and task handling. Distinguish each fact;
ACK or reply is performed only if the new test task explicitly requests and
authorizes it.

**Step 6: Final report and cleanup**

Report Status/Verdict, commits/files, tests, production evidence, MCP source,
risks and next action. Retain the task worktree until integration direction is
provided; do not push, merge or release. If the worktree later becomes eligible
for cleanup, use the repository worktree lifecycle and verify commit reachability
first.
