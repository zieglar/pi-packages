/**
 * Pi endpoint integration CONTRACT ONLY (PH-0003). No runtime imports or calls.
 *
 * A peer endpoint can originate requests and process incoming Messages, but
 * neither its kind nor declared support grants an action. The authenticated
 * host binds exact principal/action/exchange/message/attempt/incarnation grants.
 *
 * Adapter-local routing maps an opaque stable endpoint to a durable installation
 * and session binding, with a fresh process incarnation on restart. Credentials,
 * session paths, provider handles, pane IDs and SSH keys never enter protocol data.
 *
 * Public owning-session seam, verified against Pi 0.86.1 documentation:
 * - pi.sendUserMessage(...) wakes the owning idle session;
 * - pi.sendMessage(...) offers steer/followUp/nextTurn modes;
 * - sessionManager.getSessionId()/getSessionFile(), lifecycle events and
 *   pi.appendEntry(...) provide identity/observation/persistence building blocks.
 * No competing RPC session is created. The official handoff example itself
 * creates a NEW session/editor draft; it is not existing-session transport proof.
 *
 * Availability is not correlated acceptance/settlement evidence. Missing runtime
 * observation or cancellation confirmation stays UNKNOWN/unsupported. A future
 * integration must durably dedupe/fence and mark dispatch intent BEFORE effects;
 * no catch-all fallback/retry is licensed after possible delivery.
 *
 * PH-0002 source pins and existing-delivery seam limitations remain in
 * docs/source-reuse-audit.md; discovery-only composition is a later option.
 * No production extension, delivery, observation or result publication exists.
 *
 * CE-0002 B3-P3B amendment: the Pi-type-free host seam `session-host.ts` now
 * exists beside this contract. It is host-local composition over the private
 * B3-P3A authorized send/read slice: an operator-controlled endpoint allowlist,
 * memory-only capability tokens, validated mapping recovery, and sanitized
 * refusals. It still grants no endpoint delivery, no ACK, no inbox discovery,
 * and no transport: a stored Message becomes conversation-visible only when the
 * receiving host explicitly reads its metadata and chooses to inject it via the
 * owning-session seam above. Pi session ids remain untrusted labels throughout.
 */
import type { EndpointDeclaration } from "../../protocol/endpoint-capabilities.js";

export const PI_ADAPTER_KIND = "pi" as const;
/** Declaration shape only; deliberately no constant advertises implemented support. */
export type PiEndpointDeclaration = EndpointDeclaration & { readonly kind: typeof PI_ADAPTER_KIND };
