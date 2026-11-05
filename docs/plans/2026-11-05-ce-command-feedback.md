# CE command feedback implementation plan

Goal: Fix the seven P2 feedback defects reviewed at c18c8bc, preserving permission, message and Tunnel lifecycle behavior.

Design: Use native Pi setStatus under a separate operation key for honest activity text, and clear it at completion or session invalidation. Preserve existing measured transport status. Distinguish ordinary cancellation, failure and committed/pending results; suppress stale output. Add no confirmations, automatic retries, process cancellation, transport actions or durable workflow markers. The user's explicit implementation authorization accepts the preceding review design; no additional design approval is needed.

Execution: Work on local branch fix/ce-command-feedback. Independent edits have disjoint file ownership; parent owns integration and commit. No merge, push, release, install, reload of the active session, or real Tunnel operation.

1. Add failing behavior tests for operation activity/cleanup, cancellation, reload handoff and live error advice using controlled boundaries. Implement changes in pi-extension/index.ts and multi-session-commands.ts; adjust onboarding/manager/setup adapters only as needed.
2. Add failing Hooks UI tests for activity, ordinary cancellation/timeout, fixed-fixture failure classification and invalidated completion. Implement in hooks-management-ui.ts; parent handles command-context validity and notification in index.ts. Keep committed/pending results intact.
3. Add failing Native tests for structured outcome severity and activity, retaining runNativeCommand's existing textual API where compatibility needs it. Implement in runtime/native-readiness.ts; parent integrates extension notification.
4. Under existing Node 24.21.0, rebuild local artifacts, run targeted feedback/UI/lifecycle tests, typecheck and repository checks. Tests use private HOME and default-client guard. Never run real CE commands or modify production configuration.
5. Freeze the diff, run independent specification/code review plus authority/lifecycle review; resolve findings and rerun affected checks. Record actual verification and limitations, then create one local commit with only task files.

Acceptance: All seven defects addressed; real waiting activity is visible without percentages; success/failure/user cancellation have accurate terminal feedback; stale contexts cannot publish late success; reload preserves saved facts; live errors do not indiscriminately recommend Stop; Native failures use warning/error. Existing confirmation counts, publication semantics, ownership and transport operations remain unchanged.
