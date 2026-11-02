# HANDOFF-CE-DAILY-INTEGRATION-01 — local reconciliation and dogfood

This continues the original handoff. The fixed private baseline is 675b9ea270325fe68171f57b2fdd6d49aec76e1a (tree de30110615de8b27070538c9740ce5143aeda1f2); published CE 0.3.0 is 679a0bac356768ca5e44d09a6bb063e56ac16fbc. The repository is not shallow, has no replace refs, and these histories have no common ancestor: public history was exported separately. The user authorizes a local merge retaining both histories, no reset/rebase/cherry-pick/push/PR/release.

## Reconciliation method

Prepare in /Users/zieglar/Code/pi-packages-ce-daily-integration-01, branch integrate/ce-daily-integration-01. Use merge --no-ff --no-commit --allow-unrelated-histories against the exact release SHA. This preserves both parent histories. Retain private-only projects, workflows, dependency declarations and lockfile unchanged. The pre-Hooks public export 22a7b23d4e7a354b419e67c7565cb0c6147824d3 is a content comparison baseline, not a fabricated Git ancestor.

For each add/add conflict, compare private, published and pre-Hooks contents. Where the published file is unchanged since the pre-Hooks export, retain the private evolution; where private equals the pre-Hooks file, retain the published feature change. Combine the five independently changed files: four README/changelog files accept the published additions; the extension combines all published Hooks lifecycle/policy wiring with Daily UX, with one import conflict resolved by retaining both imports. Detailed 58-path resolution evidence is outside the repository at /private/tmp/ce-daily-integration-01/reconciliation/conflict-resolutions.json.

The integrated package, MCP service and Desktop plugin identify as 0.3.1-daily.1. This is a local prerelease identity, not the original 0.3.0 release and not an npm publication. No dependency upgrade or lockfile change. Historical compatibility evidence remains version/digest scoped and is not a claim for the new runtime.

## Published capability retention checklist

- Hooks config/events/runner source, static-command admission, metadata-only event, bounded process execution, durable at-most-once record, timeout/failure handling: exact published implementation.
- Host post-commit event and MCP config/server startup wiring: exact published implementation, except the service version identity.
- Multi-session Hooks parsing, registration preservation, loaded/current deny-only intersection and revocation: exact published implementation.
- Hook Skill, Python example, bilingual guide and package inclusion validator: retained from release.
- Storage (27 files), protocol (9), Endpoint/Session contracts (2): exact published and accepted private contents; no schema or authority change.
- Native, Tunnel/Profile selection, ownership, recovery, ACK and message semantics: retained. Daily authorization store/scope/manager and Manager/status UI modules are exact accepted Daily UX source.
- Existing Hooks configuration remains accepted; no second permission store or changed completion authority.
- Only the extension entry combines both changes. Preserve runner close/rebuild around session startup, and existing Daily connect/disconnect/session admission. Use an invocation-local Host reference for failure-path drop, satisfying strict typecheck after the published runner-lifetime reset.

## Verification and review

Use approved Node 24.21.0 and the unchanged private lockfile (offline frozen dependency installation). Build, package typecheck, explicit pi-extension typecheck and contract checks. Run affected Hooks, Pi, Tunnel, stdio/recovery and package regressions; inspect the packed runtime closure and compare unchanged release runtime bytes with the existing installed package. Retain first failures and ordinary remediation in this handoff. Initial failures were a README relative-link distribution assertion and a version-pinned test; fix links and local identity expectations. Python desktop tests require documented Python >=3.11; preserve the mistaken system3.9 failure and rerun with installed Python3.15. Do not change Ovis/Wake.

Freeze staged patch, exact file set and tree before independent Diff/authority/lifecycle/package review. Resolve supported blockers, then create a two-parent local merge commit. Verify parents, reviewed tree and ancestry, then fast-forward the verified integration into private main, preserving its original untracked files.

## Installation and real acceptance

Retain the original 0.3.0 consumer prefix and backed-up settings/Profile/binding/manifest. Confirm selected Tunnel independently STOPPED and inspect current Owner/session impact before any start/stop or installation switch. Physically install the validated tarball into a new exclusive 0.3.1-daily.1 prefix with ignore-scripts, then register one exact extension source through Pi's native package commands. Verify module bytes and actual load path, no duplicate CE entry. Preserve production Store/Profile/Exchange/credentials; only explicit supported configuration changes justified by installation are allowed, with before/after evidence.

Use real Pi1.3.0 in a real PTY, normal user settings and no CE_TUNNEL_BACKGROUND_ALLOW. Restore the exact registered native session, never substitute another Owner. Verify menu/permission/cancel, grant/connect/status/close, normal restart/reuse, revoke/start refusal and disconnect. Distinguish UI, binding, transport and message evidence. Use only explicit uniquely marked test messages for each direction and separately validate real peer reads/ACK; ChatGPT tool absence is unverified, never simulated. Stop on uncertain delivery, ownership or cleanup. Do not create unrelated features or start release work.

Final verdict is based on actual integrated/install/runtime results. No CLOSED claim until required real acceptance completes; record any concrete blocker and preserve a clear final Tunnel/Session state.
