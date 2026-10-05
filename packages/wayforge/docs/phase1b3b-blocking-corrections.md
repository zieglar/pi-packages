# Phase 1B.3B — Blocking Corrections and Pi 1.0.2 Contract Audit

This is implementation evidence, not an independent re-review or live acceptance. The existing dirty Phase 1B.3/1B.3A candidate is retained. No real provider was contacted; the installed-Pi tests inject a fetch function that always throws before network I/O. No policy, parser acceptance, routing, fallback, account integration, or logical reservation change is authorized here.

## Finding 1: isolation before authoritative returns

RED production-path regressions reproduced an approval becoming a runtime failure when a valid text block was followed by `{ type: "text" }`, an invalid verdict rejecting its promise on null block observations, and diagnostic-only property/classifier exceptions. Safe observation reads now enclose property access and classification before returning to the authoritative path. Malformed observations are omitted. Failure augmentation encloses diagnostic construction and returns the original failure if construction fails. Parser rejection classification is also best-effort; acceptance still comes solely from the unchanged strict parser.

The regressions prove the original extracted approval remains deeply equal, invalid output remains the typed `invalid_advisor_verdict`, and a pre-existing extraction failure on a null content block is not repaired. Disk-sink regressions cover both invalid and approving authoritative outcomes.

## Finding 2: preserve semantic failure information

RED reproduced replacement of `quotaWindowReliable` and `quotaWindowResetAtMs`, which changed known-window suspension into bounded continuation. Diagnostic augmentation now merges namespaced diagnostic keys first and original metadata last; no existing key, semantic or diagnostic, is overwritten. Failure kind, scope, confidence, code, message and existing metadata remain unchanged.

The suspension test retains `known_quota_window` and resume time 9000. Its complete projection deep-equals the original after removing only newly added observational metadata from the copied originating failure. The recovery implementation is unchanged.

A RED boundary regression also filled the existing 20-entry durable metadata limit and showed augmentation could displace quota keys during the existing sorted projection. If merged metadata would exceed that limit, augmentation now returns the original failure and omits diagnostics. Recovery and durable sanitization are unchanged; the boundary-case suspension projection is exactly equal before and after.

Preservation requires treating pre-existing `diag*` collisions as untrusted observations. A further RED regression showed arbitrary `diagReasoning` text and numeric usage keys could otherwise be promoted. Diagnostic reasoning is now a fixed thinking-level enum or `unavailable`; legacy/preserved usage keys are not read as provider usage. Original failure metadata is still preserved.

## Finding 3: distinguish quantities, do not invent a cost ceiling

Installed packages are Pi coding-agent and pi-ai **1.0.2**. The audit uses the installed public `@earendil-works/pi-ai/api/anthropic-messages` export in tests only. Production continues exclusively through `ExtensionContext.modelRegistry.streamSimple`.

### Quantities

| Quantity | Meaning in this candidate |
| --- | --- |
| Completion reservation | Separate one-shot Wayforge ledger with limit at most 800; unchanged |
| `NestedModelRequest.budgetLimit` | Resolved logical invocation allowance after existing policy/remaining-budget minima |
| `streamSimple` `maxTokens` | SDK option supplied as the resolved allowance, 800 for this authoritative review |
| Pi thinking transformation | Provider-adapter-dependent transformation; not a Wayforge-enforced aggregate ceiling |
| Prepared provider cap | Explicit scalar observed through supported `onPayload`, if a recognized cap exists |
| SDK accounting | Existing `usage.input + usage.output` consumption; preserved, without a provider-provenance claim |

An allowance does not prove a pre-dispatch input cost or provider output ceiling. Pi usage normalization and reasoning accounting vary by adapter; Wayforge does not have a reliable generic final-answer/reasoning split. Anthropic maps `input_tokens`/`output_tokens` into SDK counters; OpenAI normalization explicitly notes that completion tokens include reasoning tokens. No estimate is added here.

### Exact reproduced non-adaptive Anthropic transformation

For the synthetic supported model with context window 200000, model maxTokens 32000, `maxTokens: 800`, and `reasoning: high`:

1. `buildBaseOptions` leaves 800 after context clamping.
2. `DEFAULT_THINKING_BUDGETS.high` is 16384.
3. `adjustMaxTokensForThinking` computes `min(800 + 16384, 32000) = 17184`.
4. Context clamping leaves 17184.
5. Thinking budget becomes `min(16384, 17184 - 1024) = 16160`.
6. The prepared payload contains `max_tokens: 17184` and `thinking.budget_tokens: 16160`.

Sources: installed `pi-ai/dist/api/simple-options.js`, `anthropic-messages.js`, and `types.d.ts`. The passive hook returns **undefined**, which the supported contract defines as retaining the payload. Tests assert payload identity by serialized content before/after the Wayforge observer and assert its return is undefined. Unknown, ambiguous, malformed, or unobserved caps are omitted; no payload object, prompt or reasoning text is retained.

### Truthful schema v2 fields

`request.logicalBudget` is the Wayforge allowance; `request.reasoning` is the requested SDK reasoning enum; `request.sdkMaxTokens` is the SDK option actually passed (or `unavailable`). Optional `request.preparedMaxTokens` and `request.preparedMaxTokensField` describe a recognized observed prepared-payload scalar, not provider acceptance or guaranteed final enforcement. Recognized fields are only `max_tokens`, `max_completion_tokens`, and `max_output_tokens`. Unsupported/missing observations are not guessed. The former conflated `request.maxTokens` is removed and the schema version is incremented to 2.

### Adopted Advisor Budget Contract A

The normative contract is:

```text
Advisor logical allowance = 800
reasoning = high
provider generation allocation = Pi/provider managed
```

The 800 allowance is a Wayforge logical ledger/request allowance. It is **not** a guarantee of provider aggregate generation at or below 800 tokens, final textual answer at or below 800 tokens, input usage at or below 800 tokens, total provider usage at or below 800 tokens, or monetary provider cost bounded by an 800-token equivalent. Provider/model-specific reasoning and generation allocation are prepared by Pi/runtime/provider semantics. Actual usage is accounted after generation and does not retroactively invalidate an otherwise contract-valid Advisor verdict.

| Contract layer | Adopted meaning |
| --- | --- |
| Layer A — Wayforge logical allowance | 800 |
| Layer B — Pi reasoning policy | `high` |
| Layer C — provider-prepared generation allocation | Provider/model/context dependent |

The non-adaptive Anthropic calculation above (`max_tokens: 17184`, `thinking.budget_tokens: 16160`) is an audited Pi 1.0.2 provider/model example, not a universal constant. The current supported simple option does **not** enforce an aggregate 800-provider-token ceiling on that path. Capping the reproduced payload to 800 while retaining its 16160 thinking budget is not a safe valid contract. Other provider paths may omit or transform caps differently, so no universal enforcement is inferred.

Contract A changes terminology and deterministic contract assertions only. It does not authorize payload mutation, reduced reasoning, routing changes, retries, account integration, or live acceptance.

## Finding 4: unavailable provider usage is not zero usage

The installed-Pi offline failed transport receives no provider response or usage. Nevertheless Pi resolves an error-terminal assistant message with initialized zero usage. RED showed diagnostics promoted those zeros (and nonzero SDK counters) into provider usage.

The runtime retains SDK counters for existing accounting. Neither the Advisor invalid path nor successful controller diagnostic emission copies those counters into diagnostic usage. The failure metadata reader does not promote legacy/preserved usage keys. Generic Pi 1.0.2 messages do not reliably distinguish initialized/default counters from genuinely supplied usage across all supported paths, so provider usage is omitted. Zero and nonzero values are never used to infer provenance.

## Scope and remaining non-blocking concerns

Only diagnostic helpers, their adapter/controller wiring, the observation contract, directly affected tests, and this audit are corrected. CompletionAuthority, readiness/candidate construction, recovery, leases/CAS, the 800 reservation, high thinking and routing/fallback/account policy remain unchanged.

Correlation string lengths and the trace-to-durable sensitive-value dependency remain for later assessment; this pass is not a generalized schema redesign. The reasoning enum restriction is directly necessary to prevent newly preserved metadata collisions from carrying raw diagnostic text. Provider usage availability is intentionally conservative. A fresh independent re-review is still required; this implementation session does not perform it.
