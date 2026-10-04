/**
 * Branded identity types for the Wayforge kernel. Brands are compile-time
 * only; they prevent accidental mixing of identifier kinds without changing
 * runtime representation.
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

/** Unique identifier of one invocation attempt in the derivation tree. */
export type InvocationId = Brand<string, "InvocationId">;
/** Identifier of the durable task an invocation belongs to. */
export type TaskId = Brand<string, "TaskId">;
/** Identifier of a capability descriptor in the static catalog. */
export type CapabilityId = Brand<string, "CapabilityId">;
/** Identifier of a statically configured model route. */
export type RouteId = Brand<string, "RouteId">;

export const invocationId = (raw: string): InvocationId => raw as InvocationId;
export const taskId = (raw: string): TaskId => raw as TaskId;
export const capabilityId = (raw: string): CapabilityId => raw as CapabilityId;
export const routeId = (raw: string): RouteId => raw as RouteId;
