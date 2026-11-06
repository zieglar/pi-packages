# CE Routing Guidance and Read-Refusal Presentation Implementation Plan

> **For Pi:** Execute the approved design task-by-task with test-driven development and a final review checkpoint.

**Goal:** Make recipient selection guidance current and explicit, and show message-eligibility refusals without mislabeling them as Host outages.

**Architecture:** Keep Host/Protocol/Store and structured error results unchanged. Change only MCP/Pi adapter presentation and MCP caller guidance; prove the existing real cross-Endpoint authorization behavior with focused fixtures.

**Tech Stack:** TypeScript, TypeBox, Vitest, Pi extension tools, MCP tool descriptors.

### Task 1: MCP routing guidance and refusal presentation

**Files:** `src/control/mcp/messaging-tools.ts`, `test/control/mcp/messaging-tools.test.ts`

1. Add failing assertions that the `ce_send` descriptor/schema direct live callers to refresh `ce_endpoints`, avoid stale recipient labels, and require explicit selection when intent is ambiguous.
2. Add a failing `ce_read_payload` test with a synthetic `CE_HOST_UNAVAILABLE`/`MESSAGE_READ_REJECTED` refusal. Require fixed eligibility text, no Host-offline claim, unchanged structured code/reason/retryable fields, and no private error text or metadata.
3. Run `pnpm exec vitest run test/control/mcp/messaging-tools.test.ts`; record the expected RED.
4. Make the smallest descriptor and presentation-only change. Preserve generic handling for every other error.
5. Rerun the test and confirm GREEN.

### Task 2: Real Pi cross-Endpoint presentation

**Files:** `pi-extension/index.ts`, `test/endpoints/pi/extension-multi-session.test.ts`

1. Strengthen the existing real A/B fixture: A reads its own message successfully; B's metadata/payload reads of A's message fail with fixed eligibility text rather than a Host-offline message. Assert structured details remain unchanged and no protected text is exposed.
2. Build, then run the focused file and record RED against the current adapter.
3. Add the same fixed-reason presentation branch in the Pi adapter only. Do not change `guardedEndpoint`, Host calls, or message authorization.
4. Rebuild and rerun; confirm correct-recipient success and cross-Endpoint denial both remain GREEN.

### Task 3: Caller documentation, verification and commit

**Files:** `docs/tunnel-setup.md`, `docs/tunnel-setup.zh-CN.md`

1. In ChatGPT→Pi instructions, require fresh `ce_endpoints` discovery in live mode, exact intentional selection, no stale Endpoint reuse, and explicit user selection for ambiguity. Retain the existing `CREATED` evidence limitation.
2. Run focused MCP/Pi tests, package typecheck/build/check, and diff hygiene. Review that no Host/Protocol/Store, Hook/Ovis, permission, Tunnel, or unrelated user file changed.
3. Commit only the scoped implementation, tests, documentation, and this plan locally. Do not install or restart the shared Tunnel, Push, Merge, or Release. Report production behavior as unchanged until separately deployed.
