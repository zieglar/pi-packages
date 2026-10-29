[English](ph0002-validation.md) | [简体中文](ph0002-validation.zh-CN.md)

> Historical evidence or design record. Claims, commands, test results and limitations below describe the recorded phase, not current support or release eligibility.

# PH-0002 validation and acceptance evidence

Baseline verified before work: `<repository-root>`, `main`,
`a645003a68c0d0217a92cba84431d4d34f7e581c`, clean. No push.

## Approved stop-condition recovery

The 80-bit identity claim from PH-0001 was falsified: its encoder ignored
bytes 8–9 and overlapped groups from bytes 0–7. Work stopped and the draft
was reverted. The owner explicitly authorized a bounded hotfix followed by
PH-0002 resumption. Commit `58b3163dd247faf5bca31853c0e5667bbb6681f3`
changes only the encoder, its regressions and `identity-hotfix-ph0002.md`.
External `ho_`/`hr_` formats remain unchanged; timestamps remain unchanged.
Actual RED: 4 failed/7 passed identity tests; GREEN: 11/11 identity,
41/41 original-package tests; Wayforge 438/438. See the preserved hotfix doc.

## Architecture RED → GREEN

- The original architecture correction regression suite failed 4 assertions
  before refactoring: read-consumption state, product-specific result source,
  unguarded requeue, product-specific operation catalog.
- The writer's first generalized tests additionally failed against absent/new
  module paths and old lifecycle behavior. Final writer verification was
  86/86 tests, build/typecheck/architecture gates passed.
- The first independent reviewer failed before review due to provider usage
  limits. The owner authorized a model change. A fresh replacement reviewer
  verified the initial 86-test tree and reported OK. That result is **not**
  independent acceptance of the later parent fixes below.
- Parent inspection then reproduced missing evidence checks. The new
  `test/core/safety-regression.test.ts` initially had 12 failed/1 passed.
  Fixes require independent correlated runtime evidence and a published
  correlated Result; compare live mutations to the latest fenced claim;
  allow historical-lease recovery into quarantine; preserve ambiguity through
  cancellation; reject invalid timestamps and non-JSON immutable results.
- A separate namespace separator collision regression failed 1 test before
  switching the reference store to an unambiguous JSON tuple. An accidental
  literal NUL in the source was removed as part of that complete rewrite.
- Added negative architecture fixtures revealed two previously unenforced
  product identifiers (`piSessionId` and `openaiConversationId`); the gate
  failed before its token checks were corrected. The reverse Pi→MCP fixture
  also proves adapter separation.
- Final parent verification: **107/107 tests in 11 files**, including all 11
  identity hotfix regressions, in-memory MCP and mandatory built stdio MCP
  smoke, core evidence tests, opaque application evidence, namespace replay,
  schemas, lifecycle and compile-negative authority checks. Typecheck and
  build pass. **10/10 negative architecture fixtures are rejected**.
- Parent Wayforge regression: **438/438 tests in 51 files**, exit 0. Wayforge
  source diff is empty. Workspace gate and diff-whitespace checks pass.
- Active LSP probe found no errors in changed rules/schema/tests: 2 paths
  confirmed clean, 4 inconclusive. Full `tsc --noEmit` is the authoritative
  complete typecheck evidence, not an empty LSP cache.

Commands (using workspace pnpm 12.9.1 through mise):

```sh
mise x pnpm@12.9.1 -- pnpm --filter @zieglar/pi-chat-exchange run verify
mise x pnpm@12.9.1 -- pnpm --filter wayforge test
node tooling/check-workspace.mjs
mise x pnpm@12.9.1 -- pnpm run format:check
```

Transient logs are under `/tmp/ph0002-parent-{safety-red,namespace-red,gate-red,final-verify,wayforge}.log`.
The pinned, durable reuse evidence is in `source-reuse-audit.md`; scratch
reports are not required to reconstruct its source versions or conclusions.

## Acceptance boundary

The parent reviewed and accepted the corrected contracts and tests after the
independent review round cap. The final remediation was parent-reviewed,
not independently re-reviewed. No durable broker/SQLite/HTTP/auth, Pi
consumer/injection/listeners, automatic result publisher, full MCP exchange
API, production installation or account/routing/recovery changes exist.

Rules operate on trusted input snapshots. They do not authenticate adapters,
allocate persisted fencing tokens, prevent races or prove durability by
running in memory. The next host must load authoritative current claims,
active attempts and the complete message set and enforce these rules inside
atomic transactions. Public Pi APIs do not by themselves prove correlated
acceptance or semantic completion. Application outcomes remain opaque.
Real ChatGPT/desktop-client invocation acceptance remains **NOT_RUN**.
