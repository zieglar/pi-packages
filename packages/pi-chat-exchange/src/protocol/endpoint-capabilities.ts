/** Support advertisements are not evidence or authorization. No runtime binding. */
import { Type, type Static } from "@sinclair/typebox";

export const CapabilitySupportSchema = Type.Union([Type.Literal("supported"), Type.Literal("unsupported"), Type.Literal("unknown")]);
export const EndpointCapabilitiesSchema = Type.Object({
  delivery: CapabilitySupportSchema,
  observation: Type.Optional(CapabilitySupportSchema),
  cancellation: Type.Optional(CapabilitySupportSchema),
  followup: Type.Optional(CapabilitySupportSchema),
  resultProduction: Type.Optional(CapabilitySupportSchema),
}, { additionalProperties: false });
export type CapabilitySupport = Static<typeof CapabilitySupportSchema>;
export type EndpointCapabilities = Static<typeof EndpointCapabilitiesSchema>;
export type EndpointCapability = keyof EndpointCapabilities;
export interface EndpointDeclaration {
  readonly kind: string;
  readonly capabilities: Readonly<EndpointCapabilities>;
}

/** Missing support remains UNKNOWN. Nothing here creates a receipt or runtime fact. */
export function endpointCapabilitySupport(capabilities: EndpointCapabilities, capability: EndpointCapability): CapabilitySupport {
  return capabilities[capability] ?? "unknown";
}
