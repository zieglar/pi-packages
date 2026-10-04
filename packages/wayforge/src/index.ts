/**
 * Wayforge Phase 1A public contracts. Only intended domain types, pure
 * policies, and constructors are exported; the Pi compatibility adapter and
 * extension entry are exported for explicit wiring against real Pi objects.
 */

// identity and execution vocabulary
export type {
  Brand,
  CapabilityId,
  InvocationId,
  RouteId,
  TaskId,
} from "./types/identity.js";
export { capabilityId, invocationId, routeId, taskId } from "./types/identity.js";
export type {
  BudgetSnapshot,
  InvocationRole,
  ModelTier,
  PersistSafeValue,
  ThinkingLevel,
} from "./types/execution.js";

// invocation kernel
export {
  budgetExceeded,
  childInvocationId,
  createInvocation,
  InvocationContext,
} from "./kernel/invocation-context.js";
export type {
  ChildInvocationInit,
  DerivationFailure,
  DerivationResult,
  InvocationInit,
} from "./kernel/invocation-context.js";
export { CapabilityCatalog } from "./kernel/capability-catalog.js";
export type { CapabilityDescriptor } from "./kernel/capability-catalog.js";

// policies
export { RolePolicy } from "./policy/role-policy.js";
export type {
  ExecutionRequirement,
  RolePolicyFailure,
  RoleResolution,
  RoleRule,
} from "./policy/role-policy.js";
export { ModelPolicy } from "./policy/model-policy.js";
export type {
  ModelDecision,
  ModelPolicyFailure,
  ModelResolution,
  StaticModelRoute,
} from "./policy/model-policy.js";

// typed outcomes
export type {
  ExecutionResult,
  Failure,
  FailureConfidence,
  FailureKind,
  FailureMetadata,
  FailureScope,
} from "./types/result.js";
export { failure, isFailure, normalizeError, success } from "./types/result.js";

// trace
export { isSensitiveKey, redact, redactTraceMetadata } from "./trace/redaction.js";
export { createTraceEvent } from "./trace/trace.js";
export type { TraceEvent, TraceEventInput, TraceEventKind } from "./trace/trace.js";

// runtime ownership
export type {
  MainSessionModelPort,
  NestedModelOutput,
  NestedModelRequest,
  NestedModelRuntimePort,
} from "./runtime/ports.js";
export { MainModelController } from "./runtime/main-model-controller.js";
export { NestedInvoker } from "./runtime/nested-invoker.js";
export type { NestedInvokeInput, NestedInvokeSuccess } from "./runtime/nested-invoker.js";
export { PiCompatibilityAdapter } from "./runtime/pi-compatibility-adapter.js";
export { wayforgeExtension } from "./extension.js";

// recovery and health
export { RecoveryCoordinator } from "./recovery/recovery-coordinator.js";
export type {
  RecoveryAction,
  RecoveryBudget,
  RecoveryDecision,
  RecoveryInput,
  RouteHealth,
  RouteRef,
} from "./recovery/recovery-coordinator.js";
export { HealthRegistry } from "./recovery/health-registry.js";
export type { HealthRecord, HealthUpdate } from "./recovery/health-registry.js";

// durable-lite state and contracts
export {
  deserializeTaskState,
  DURABLE_TASK_STATE_VERSION,
  serializeTaskState,
  taskStateSchema,
  validTaskState,
} from "./durable/state.js";
export type {
  AuthoritativeTaskState,
  EphemeralTaskState,
  TaskStateInput,
} from "./durable/state.js";
export type {
  CheckpointStore,
  CompletionEvidence,
  CompletionEvidenceStore,
  ContinuationRecord,
  ContinuationStore,
  DriftValidator,
  Lease,
  LeaseStore,
  SuspensionRecord,
  SuspensionStore,
  TaskStore,
} from "./durable/contracts.js";

// external adapter contracts
export type {
  AccountAdapter,
  AccountRouteQuery,
  AdvisorAdapter,
  AdvisorObservation,
  AdvisorVerdict,
  ContinuationLauncher,
  ContinuationRequest,
  SanitizedRoute,
  WorkerAdapter,
  WorkerLaunchRequest,
} from "./adapters/contracts.js";
export { assertResolvedWorkerLaunch, isAdvisorVerdict } from "./adapters/contracts.js";
