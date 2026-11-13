# CE Source Unification Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development task-by-task and superpowers:verification-before-completion before reporting.

**Goal:** Make public `0.3.2` source independently build every required CE capability without private daily artifacts.

**Architecture:** Keep `0.3.2` as the base. Port source-backed session/runtime/group features, rebuild TaskOwner at the MCP and private-file authority boundaries, then wire the existing opt-in metadata probe at launch.

**Tech Stack:** TypeScript 5.9, MCP SDK 1.30, TypeBox, Vitest, Node 24.21.

---

### Task 1: Lock the TaskOwner protocol and registry contract

**Files:**
- Create: `test/control/mcp/task-owner.test.ts`
- Create: `test/control/mcp/task-owner-registry.test.ts`
- Create: `src/control/mcp/task-owner.ts`
- Create: `src/control/mcp/task-owner-registry.ts`

1. Write tests for closed arguments, registered/unverified projections, schema/scope mismatch, duplicate keys, symlinks, permissions, oversize files and reconnect-stable reads.
2. Run the tests and record RED because modules are absent.
3. Implement only the validated schemas and bounded private-file reader.
4. Run the tests to GREEN.

### Task 2: Add MCP TaskOwner admission and composition

**Files:**
- Modify: `src/control/mcp/server.ts`
- Modify: `src/bin/mcp-stdio.ts`
- Modify: `test/control/mcp/server-admission.test.ts`
- Create/modify: focused stdio composition test

1. Add failing tests for conditional advertisement, missing port, general admission, TaskOwner-specific admission and execution-guard ordering.
2. Add `taskOwner` and `taskOwnerAdmission` to the binding and dispatch.
3. Wire validated sidecar, exchange/from/to scope and fresh ACTIVE/inbox/live-recipient admission in the composition root.
4. Verify RED→GREEN and that messaging/ACK rows remain unchanged.

### Task 3: Port source-backed session and runtime capabilities

**Files:**
- Add: `src/tunnel/session-switch-observation.ts`, `src/tunnel/current-runtime-binding.ts`, `src/tunnel/endpoint-runtime-binding.ts`, `src/bin/ce-runtime-binding.ts`, `pi-extension/runtime-binding-command.ts`
- Modify: `src/control/mcp/endpoint-discovery.ts`, `src/tunnel/live-mcp-composition.ts`, `src/bin/mcp-stdio.ts`, `pi-extension/index.ts`
- Add/modify: corresponding recovered Vitest files

1. Copy only the verified TypeScript/test implementations from the preserved development worktree.
2. Reconcile them with public `0.3.2` native-read and Source Metadata Probe changes.
3. Run Session Switch, Runtime Binding, Named Group and `ce bind` tests.

### Task 4: Wire Source Metadata Probe without changing defaults

**Files:**
- Modify: `src/bin/mcp-stdio.ts`
- Preserve: existing three probe files
- Add/modify: launch test

1. Add a failing launch-boundary test proving default-off and exact digest opt-in.
2. Construct the probe only from trusted launch configuration/environment scope already specified by the probe contract.
3. Verify denied/invalid/non-ping calls never sample and outputs never contain metadata values.

### Task 5: Verify and review the fixed source state

1. Run all affected tests under Node 24.21.
2. Run package typecheck and build from formal source.
3. Verify generated TaskOwner/session/runtime artifacts exist and no build input resolves under private daily install paths.
4. Check `git diff`, preserve the original three probe changes, and confirm no Wayforge changes.
5. Run independent authority/security, validation/coverage and diff/maintainability reviews against the same worktree state; fix concrete findings and rerun affected verification.
