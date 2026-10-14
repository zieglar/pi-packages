/**
 * CE-0002 B3-P3B — Pi-type-free host integration seam (compatibility surface).
 *
 * HANDOFF-853274 moved the endpoint-neutral host authority chain into
 * `src/host/endpoint-host.ts` without changing it. This module keeps the
 * original Pi import path, names, and policy shape:
 *
 * - `CeSessionHost` is the shared host fixed to the Pi adapter. Its constructor
 *   still refuses a non-Pi adapter and an empty `piSessionId` exactly as before.
 * - Pi session ids remain untrusted lookup labels; they authorize nothing.
 * - Lease lifecycle (`renew`, `end`) and `requireUnowned` exist on the shared
 *   host but are opt-in; the Pi extension does not call them, so Pi Session
 *   binding, restart recovery (`resume`), and lease-expiry fail-closed behavior
 *   are unchanged.
 * - Cross-adapter recipients are available only when the operator lists them
 *   explicitly in `recipients`; without that list Pi sends exactly as before.
 * - No automatic takeover recovery: expired Pi authority still fails closed; the
 *   separate operator-only recovery caller is not reachable from this wrapper.
 */
import { PI_ADAPTER_KIND } from "./contract.js";
import {
  CeEndpointHost,
  CeHostRefusal,
  type CeEndpointHostPolicy,
} from "../../host/endpoint-host.js";
import type { DurableStore } from "../../storage/store.js";

export {
  CeHostRefusal,
  type CeBeginSessionOptions,
  type CeEndResult,
  type CeHostRefusalCode,
  type CeInboxResult,
  type CeMappingIdentifiers,
  type CeReadPayloadResult,
  type CeReadResult,
  type CeRecipientRef,
  type CeRenewResult,
  type CeSendResult,
  type CeStatus,
} from "../../host/endpoint-host.js";

/** One operator-controlled allowlist entry. `piSessionId` is an untrusted
 * lookup label only: it selects which Endpoint this Pi session may operate,
 * and authorizes nothing by itself. */
export interface CeAllowlistEntry {
  /** The Pi session id (`pi --session-id …`) this entry applies to. */
  readonly piSessionId: string;
  /** Stable operator-assigned Endpoint label (the CE `endpointId`). */
  readonly endpointId: string;
}

export interface CeHostPolicy extends Omit<CeEndpointHostPolicy, "adapter" | "allowlist"> {
  /** Endpoint adapter kind; fixed to the Pi adapter. */
  readonly adapter: typeof PI_ADAPTER_KIND;
  /** The complete set of Endpoints this host is willing to operate. */
  readonly allowlist: readonly CeAllowlistEntry[];
}

/**
 * The trusted Pi host adapter. One instance per Pi process; one authority row
 * per allowlisted Endpoint.
 */
export class CeSessionHost extends CeEndpointHost {
  constructor(store: DurableStore, policy: CeHostPolicy) {
    if (policy.adapter !== PI_ADAPTER_KIND) throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");
    for (const entry of policy.allowlist) {
      if (typeof entry.piSessionId !== "string" || entry.piSessionId.length === 0) {
        throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");
      }
    }
    super(store, policy);
  }
}
