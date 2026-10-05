/**
 * Pi adapter CONTRACT (documentation only — frozen v2, PH-0002).
 *
 * This module declares how a future Pi-runtime adapter binds the AGENT port
 * to a Pi session. It performs NO runtime Pi API calls, imports no Pi
 * packages, and installs nothing. Implementation is deferred until the
 * durable host exists and the seam below is accepted.
 *
 * ## Binding
 *
 * - The adapter implements the agent-side operations (`AGENT_OPERATIONS` in
 *   protocol/capabilities.ts): claim, durable dispatch-start, delivery/
 *   activity/ settlement reporting, result publication, lease release,
 *   ambiguity reconciliation, cancellation confirmation.
 * - Endpoint mapping is opaque and non-secret:
 *   - `adapter: "pi"`;
 *   - `endpointId` = the DURABLE session identity of the destination;
 *   - `instanceId` = the live process incarnation (ephemeral; changes across
 *     restarts while `endpointId` stays stable).
 * - Credentials, auth files, and any Pi-runtime-specific handles stay
 *   adapter-local. They never enter an EndpointRef, Message, or Event.
 *
 * ## Delivery seam (public, owning-session APIs only)
 *
 * The example in the official distribution (`examples/extensions/handoff.ts`,
 * read at the actual user runtime 0.86.1 at the documented mise install
 * path; a child audit also covered the installed 0.85.1 — versions
 * deliberately labeled) is itself a NEW-session flow: summarize the current
 * session, edit the draft, then `newSession` with parent tracking. It is NOT
 * evidence of existing-session injection. The public existing-session
 * injection API evidence comes from the official `extensions.md`
 * documentation verified at 0.86.1:
 * `pi.sendMessage(customMessage, { deliverAs: "steer"|"followUp"|"nextTurn", triggerTurn })`
 * and `pi.sendUserMessage(...)` for waking an idle owning session, with
 * session identity via `sessionManager.getSessionId()/getSessionFile()` and
 * durable extension entries via `pi.appendEntry(...)`. No competing Pi
 * session is ever launched; RPC mode stays rejected (see
 * docs/phase-0-evidence.md, archival).
 *
 * ## Receipt integration limitations (why no composition is claimed)
 *
 * The decisive ground for all audited comm plugins is the same: none offers
 * a seam where OUR durable dedupe, lease fencing, and explicit no-retry
 * decision can execute BEFORE their own injection/retry machinery acts.
 * Secondary facts (in-memory state, differing ID formats, socket-level ACK
 * semantics) are facts, not refusal grounds. Pins and versions in
 * docs/source-reuse-audit.md:
 *
 * - pi-intercom 0.16.1 exposes an in-process extension event bus (discovery
 *   `listSessions`, generic pub/sub with owner election and epoch-fenced CAS
 *   commits, and an outbox). Its outbox AUTO-INJECTS
 *   `sendMessage`/`sendUserMessage` from its own in-memory dedupe, with no
 *   hook where our durable dispatch-start attempt record and lease fencing
 *   could gate the injection first; outbox timeouts and session-end
 *   conditions surface as generalized opaque failures, not correlated
 *   delivered/ambiguous/failed evidence. Discovery-only composition
 *   (already-installed `listSessions`) remains a later option.
 * - remote-pi 0.7.0 (repo pinned by SHA in the audit) acknowledges at the
 *   broker with `received` after a socket write — transport acceptance, not
 *   runtime acceptance (a semantics fact, not by itself a refusal ground).
 *   The refusal ground: its injection path (in-memory pending buffer drained
 *   via `sendMessage`) has no seam for our durable dedupe/fencing/no-retry,
 *   and retry decisions are delegated to the sending LLM.
 * - pi-relay 0.4.0 has a published durable core, but its delivery ladder
 *   (steer → follow-up → fallback) retries inside catch-all exception
 *   handlers plus claim recovery; those paths may have side effects it
 *   cannot account for, so we cannot claim composing it preserves our
 *   fail-closed no-retry quarantine. No complete no-effect certainty is
 *   claimed about it.
 *
 * ## Acceptance caveat (frozen)
 *
 * Availability of these public APIs is necessary but NOT correlated durable
 * acceptance or settlement proof. Only attempt-correlated evidence (dispatch
 * marker, transport trichotomy, runtime ladder) recorded through the core
 * rules may move a Message's lifecycle. Real client-product acceptance
 * (ChatGPT or otherwise) remains NOT_RUN.
 */
import type { AgentOperation } from "../../protocol/capabilities.js";

/** The adapter kind label used by Pi endpoint refs. */
export const PI_ADAPTER_KIND = "pi" as const;

/**
 * Contract-only port declaration for the future Pi adapter. It exists so the
 * binding and its limitations are reviewable; no implementation is provided
 * or implied in this phase. Composed, not inherited: the adapter declares the
 * same narrow agent-authority shape plus its adapter kind.
 */
export interface PiAgentPort {
  readonly authority: "agent";
  readonly operations: readonly AgentOperation[];
  /** Endpoints are durable session identities with ephemeral instances. */
  readonly resolvesEndpointsOfAdapter: typeof PI_ADAPTER_KIND;
}
