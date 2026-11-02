# CE daily usage implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Handoff:** HANDOFF-CE-DAILY-UX-01

**Goal:** Restore an explicitly configured Pi session with one CE command while preserving process startup permission, immutable registrations, ownership, and transport lifecycle authority.

**Architecture:** Keep `CE_TUNNEL_BACKGROUND_ALLOW === "1"` in the real background manager unchanged. A user-owned external shell function starts the parent Pi process with that permission and explicit session selection; no CE configuration boolean grants authority. Add `connect`/`disconnect` under the existing `ce-tunnel` command, composing current activation, admission, release and background-manager APIs with explicit state checks and cancellation. Preserve existing transport-only `start`/`stop` and all frozen protocol, Store, receipt and completion contracts.

**Tech Stack:** TypeScript, Pi 1.3.0 extension ports, Vitest, isolated SQLite, existing Python and Node desktop-tool regressions.

## Baseline and boundaries

- Base: `b0cc63dbaeac823df672de0cdd04427fc29650c7`, private `main`, origin/main ahead 171 / behind 0 at observation (local refs, no fetch).
- Worktree: dedicated `feat/ce-daily-ux-01`; preserve the source checkout's three pre-existing untracked paths.
- Repository package metadata is historical `0.2.2`; installed production CE is `0.3.0`. This change does not rewrite that version or replace the installed package. Build and test this exact source; report installation/production validation separately.
- Production background record observed STOPPED with its old process absent. Do not change production Profile, Store, credentials, Magpie, messages or desktop tools.
- `multi-session-policy.ts` forbids assigning an existing stable Endpoint to a different native Pi session. Resume the registered native session; new native sessions need explicit unique registration. No automatic rebind, takeover, Owner deletion or recovery.
- Persistent CE authorization would change the documented process gate and is deferred. The external launcher sets the existing parent environment normally; it neither autostarts transport nor injects permission into an already running Pi or client child.

## Design alternatives and decision

1. Persist a permission in profile or mutate the running Pi environment: rejected; changes or bypasses the process permission boundary.
2. Documentation alone with existing activate/start/deactivate/stop: safe but retains repetitive daily CE operations.
3. Preserve process permission and add state-aware connect/disconnect using the existing implementation: selected. Report ACCEPT WITH FOLLOW-UP for persistent permission and arbitrary new-session endpoint reuse.

## Task 1: Regression cases (Red)

Files: `test/endpoints/pi/extension-messaging-activation.test.ts`, `test/tunnel/extension-deferred-start.test.ts` (or a focused daily-use test beside these fixtures).

- Verify unauthorized connect refuses before activation or transport start and points to the parent environment remedy.
- Verify a registered unbound current session can confirm existing activation then connect, without registration/configuration publication.
- Verify cancelled activation, different native session, changed profile, Busy/expired Owner and uncertain release cannot reach transport start.
- Verify disconnect closes tool admission immediately and releases only the current Owner, then stops the existing manager; stop failure cannot reopen CE admission.
- Verify clean release and restoration of the same native session can activate a new CE incarnation without duplicating Endpoint or Exchange; no unreleased mapping is discarded.
- Run focused cases before implementation and retain expected assertion failures outside the checkout.

## Task 2: Minimal command composition (Green)

Files: `pi-extension/index.ts`, directly necessary existing test files.

- Add connect/disconnect completions and help under `ce-tunnel`.
- Gate connect with interactive TUI and exact process permission before binding writes; use existing Native admission.
- Capture and revalidate native session, environment/profile and loaded policy across awaits. Existing activation owns confirmation, required reload, STOPPED lock and requireUnowned checks.
- Existing valid binding may inspect a running owned tunnel without restarting it. Fresh activation against running transport refuses and tells the operator to Stop explicitly.
- Await or supervise the canonical background start result, publish measured state, fence stale-session callbacks and merge/reject overlapping daily operations. No retries or automatic Stop/Start.
- Disconnect synchronously closes admission before awaiting cleanup, uses `shutdownCe` and existing manager stop, and reports release and transport failures independently.
- Preserve legacy explicit activate/start/stop behavior and all deny-only admission checks.
- Improve unauthorized start diagnostics with the exact parent Pi opt-in remedy.

### Design review closure

- The fixed-baseline design review requested result, identity, shared-stop and sequencing clarifications. Connect never infers success from a void activation handler: it verifies the resulting generation, guarded endpoint and ACTIVE lease before transport. Cancellation/reload/refusal cannot pass that check.
- The factory records its loaded runtime environment and cached Manager profile selection. Both must match the command's target, with profile text fenced across asynchronous confirmation/start/refresh. No policy reload or target switch in place.
- Disconnect has its own confirmation naming the shared profile transport and other-session interruption. It saves the previous generation, closes admission after confirmation, awaits release plus an independent Stop attempt, and separately reports uncertain release/stop. Existing deactivate confirmation remains transport-neutral.
- Connect checks TUI/exact opt-in, then Native/runtime, then loaded identity, then optional STOPPED activation, then guarded ACTIVE binding, then canonical Manager start and measured refresh. No lifecycle call occurs inside the activation configuration lock.
- Transport start failure retains an already established binding. No automatic cleanup/retry. Disconnect release failure does not prevent a single independent Stop attempt; neither outcome clears an authority failure latch.
- Exit/reload abort UI and suppress stale completion notices; manual Stop aborts pending daily activation and joins the manager's existing start/stop supervision. Unknown ownership/identity and expired Owner evidence never authorize recovery.

## Task 3: Usage documentation

Files: new English/Chinese daily-use guide and links from current tunnel/multi-session guides; command README/help where necessary.

- Show once-configured portable shell function using `CE_TUNNEL_BACKGROUND_ALLOW=1 pi --resume`, preserving normal Pi executable/Node selection.
- First-time endpoint/profile/grants selection and explicit configuration; existing multi-session registration only once per native Pi session, no need to recreate Exchange.
- Daily same-session restore, connect/status/disconnect; distinguish disconnect from transport-only stop and ordinary Pi exit.
- Explicit remaining costs: session selection, activation confirmation, explicit STOPPED requirement for fresh activation, unsupported automatic new-session reuse and crash recovery.
- Separate transport health, CE binding, model availability and task authorization/completion. Do not claim cloud, long-duration or production installation verification.

## Task 4: Verify and review

- Build, typecheck and CE contract gate; targeted activation, lifecycle, multi-session, background-manager and command regression tests under approved Node 24.21.0 with guarded client boundaries.
- Python unittest discovery and Node `--test` for both existing Ovis/Wake directories; no desktop/cloud execution.
- Active diagnostics on changed TypeScript paths; report coverage gaps instead of treating empty cache as proof.
- Fix the final exact patch/manifest and run independent fresh-context lanes A (diff/privacy/docs), B (authority/frozen architecture), C (validation/coverage), D (standards/maintainability). Preserve lane results and parent synthesis outside the repository. Recheck target hashes before/after review.
- Remediate supported blockers and rerun affected tests/review. Local commit only after verification/review; no push/merge/release.
- Completion report includes exact commit/files, test counts/log evidence, lane provenance, executable usage and explicitly unverified production/long-running behavior.
