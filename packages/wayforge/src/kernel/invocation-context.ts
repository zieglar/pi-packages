import type { InvocationId, TaskId } from "../types/identity.js";
import { invocationId as mkInvocationId } from "../types/identity.js";
import type {
  BudgetSnapshot,
  InvocationRole,
  PersistSafeValue,
} from "../types/execution.js";

/**
 * Internal mutable ledger shared by every context in one derivation tree.
 * Consumption recorded anywhere in the tree is visible to all contexts; each
 * context's own limit never grows. The ledger is deliberately not exported as
 * part of persist-safe state.
 */
class SharedBudgetLedger {
  consumed = 0;
}

/** Typed failure returned when a child derivation must fail closed. */
export type DerivationFailure =
  | { readonly kind: "max_depth_exceeded"; readonly depth: number; readonly maxDepth: number }
  | {
      readonly kind: "budget_increase_forbidden";
      readonly requested: number;
      readonly limit: number;
    };

export type DerivationResult =
  | { readonly ok: true; readonly context: InvocationContext }
  | { readonly ok: false; readonly failure: DerivationFailure };

export interface InvocationInit {
  readonly invocationId: InvocationId;
  readonly taskId: TaskId;
  readonly role: InvocationRole;
  readonly maxDepth: number;
  readonly budgetLimit: number;
  readonly traceMetadata?: Readonly<Record<string, PersistSafeValue>>;
}

export interface ChildInvocationInit {
  readonly invocationId: InvocationId;
  readonly role: InvocationRole;
  /** Smaller explicit budget for the child; must not exceed the parent limit. */
  readonly budgetLimit?: number;
  readonly traceMetadata?: Readonly<Record<string, PersistSafeValue>>;
}

function persistSafe(metadata: Readonly<Record<string, unknown>> | undefined) {
  const safe: Record<string, PersistSafeValue> = {};
  if (metadata) {
    for (const [key, value] of Object.entries(metadata)) {
      if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        safe[key] = value;
      }
    }
  }
  return safe as Readonly<Record<string, PersistSafeValue>>;
}

/**
 * One node in an invocation derivation tree. Field values are immutable;
 * budget consumption flows through a shared ledger and cancellation flows
 * downward through linked AbortControllers. The linked AbortSignal is runtime
 * state and never appears in trace metadata.
 */
export class InvocationContext {
  readonly invocationId: InvocationId;
  readonly taskId: TaskId;
  readonly role: InvocationRole;
  readonly parentInvocationId: InvocationId | undefined;
  readonly depth: number;
  readonly maxDepth: number;
  private readonly limit: number;
  private readonly ledger: SharedBudgetLedger;
  private readonly controller: AbortController;
  readonly traceMetadata: Readonly<Record<string, PersistSafeValue>>;

  private constructor(init: {
    invocationId: InvocationId;
    taskId: TaskId;
    role: InvocationRole;
    parentInvocationId: InvocationId | undefined;
    depth: number;
    maxDepth: number;
    limit: number;
    ledger: SharedBudgetLedger;
    parentSignal: AbortSignal | undefined;
    traceMetadata: Readonly<Record<string, PersistSafeValue>>;
  }) {
    this.invocationId = init.invocationId;
    this.taskId = init.taskId;
    this.role = init.role;
    this.parentInvocationId = init.parentInvocationId;
    this.depth = init.depth;
    this.maxDepth = init.maxDepth;
    this.limit = init.limit;
    this.ledger = init.ledger;
    this.controller = new AbortController();
    this.traceMetadata = init.traceMetadata;
    if (init.parentSignal) {
      if (init.parentSignal.aborted) {
        this.controller.abort();
      } else {
        init.parentSignal.addEventListener(
          "abort",
          () => {
            this.controller.abort();
          },
          { once: true },
        );
      }
    }
  }

  static create(init: InvocationInit): InvocationContext {
    if (init.maxDepth < 0) throw new RangeError("maxDepth must be >= 0");
    if (init.budgetLimit < 0) throw new RangeError("budgetLimit must be >= 0");
    return new InvocationContext({
      ...init,
      parentInvocationId: undefined,
      depth: 0,
      limit: init.budgetLimit,
      ledger: new SharedBudgetLedger(),
      parentSignal: undefined,
      traceMetadata: persistSafe(init.traceMetadata),
    });
  }

  /** Live budget snapshot: immutable limit, shared consumption. */
  get budget(): BudgetSnapshot {
    return {
      limit: this.limit,
      consumed: this.ledger.consumed,
      remaining: Math.max(0, this.limit - this.ledger.consumed),
    };
  }

  /** Linked cancellation signal. Runtime-only; never persist this. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Request cancellation for this subtree. Never propagates upward. */
  requestCancellation(): void {
    this.controller.abort();
  }

  /** Record consumption into the shared ledger of the derivation tree. */
  spend(amount: number): void {
    if (amount < 0) throw new RangeError("spend amount must be >= 0");
    this.ledger.consumed += amount;
  }

  /**
   * Derive a child context. Depth increments and the derivation fails closed
   * beyond maxDepth; the child budget may shrink but never exceed the parent
   * limit; cancellation links downward from parent to child.
   */
  deriveChild(init: ChildInvocationInit): DerivationResult {
    const depth = this.depth + 1;
    if (depth > this.maxDepth) {
      return {
        ok: false,
        failure: { kind: "max_depth_exceeded", depth, maxDepth: this.maxDepth },
      };
    }
    const requested = init.budgetLimit ?? this.limit;
    if (requested > this.limit) {
      return {
        ok: false,
        failure: {
          kind: "budget_increase_forbidden",
          requested,
          limit: this.limit,
        },
      };
    }
    return {
      ok: true,
      context: new InvocationContext({
        invocationId: init.invocationId,
        taskId: this.taskId,
        role: init.role,
        parentInvocationId: this.invocationId,
        depth,
        maxDepth: this.maxDepth,
        limit: requested,
        ledger: this.ledger,
        parentSignal: this.controller.signal,
        traceMetadata: persistSafe({ ...this.traceMetadata, ...init.traceMetadata }),
      }),
    };
  }
}

/** Convenience factory mirroring `InvocationContext.create`. */
export const createInvocation = (init: InvocationInit): InvocationContext =>
  InvocationContext.create(init);

/** True when the shared ledger has fully consumed this context's limit. */
export const budgetExceeded = (context: InvocationContext): boolean =>
  context.budget.consumed >= context.budget.limit;

/** Deterministic child id generator for tests and callers that need one. */
export const childInvocationId = (parent: InvocationContext, suffix: string): InvocationId =>
  mkInvocationId(`${parent.invocationId}/${suffix}`);
