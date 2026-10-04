import type { CapabilityId } from "../types/identity.js";
import { capabilityId } from "../types/identity.js";

/**
 * Static description of what a capability level supports. The catalog is pure
 * configuration: policies consume these facts and never call providers.
 */
export interface CapabilityDescriptor {
  readonly id: CapabilityId;
  /** Tool calling support. */
  readonly tools: boolean;
  /** Streaming responses support. */
  readonly streaming: boolean;
  /** Reasoning/thinking support. */
  readonly reasoning: boolean;
  /** Providers the capability is restricted to; undefined means any. */
  readonly allowedProviders?: readonly string[];
  /** Models the capability is restricted to; undefined means any. */
  readonly allowedModels?: readonly string[];
  /** Whether nested invocations may be derived under this capability. */
  readonly allowNestedInvocation: boolean;
  /** Whether this capability may serve worker-role work. */
  readonly workerEligible: boolean;
  /** Whether this capability may serve advisor-role work. */
  readonly advisorEligible: boolean;
}

function createCatalog(): Record<string, CapabilityDescriptor> {
  return {
  "cap-main": Object.freeze({
    id: capabilityId("cap-main"),
    tools: true,
    streaming: true,
    reasoning: true,
    allowNestedInvocation: true,
    workerEligible: false,
    advisorEligible: false,
  }),
  "cap-nested": Object.freeze({
    id: capabilityId("cap-nested"),
    tools: true,
    streaming: true,
    reasoning: false,
    allowNestedInvocation: false,
    workerEligible: true,
    advisorEligible: false,
  }),
  "cap-advisor": Object.freeze({
    id: capabilityId("cap-advisor"),
    tools: false,
    streaming: true,
    reasoning: true,
    allowNestedInvocation: false,
    workerEligible: false,
    advisorEligible: true,
  }),
  "cap-stream-only": Object.freeze({
    id: capabilityId("cap-stream-only"),
    tools: false,
    streaming: true,
    reasoning: false,
    allowedProviders: Object.freeze(["anthropic"]),
    allowedModels: Object.freeze(["claude-haiku"]),
    allowNestedInvocation: false,
    workerEligible: false,
    advisorEligible: false,
  }),
  };
}

const CATALOG: Readonly<Record<string, CapabilityDescriptor>> = Object.freeze(createCatalog());
const CATALOG_ENTRIES = Object.values(CATALOG);
const ALL_DESCRIPTORS: readonly CapabilityDescriptor[] = Object.freeze(CATALOG_ENTRIES);

/**
 * Static catalog of capability facts. Phase 1A ships a frozen in-repository
 * catalog; there is no dynamic registration or provider probing.
 */
export const CapabilityCatalog = {
  has(id: CapabilityId): boolean {
    return Object.prototype.hasOwnProperty.call(CATALOG, id);
  },
  get(id: CapabilityId): CapabilityDescriptor | undefined {
    return CATALOG[id];
  },
  all(): readonly CapabilityDescriptor[] {
    return ALL_DESCRIPTORS;
  },
} as const;
