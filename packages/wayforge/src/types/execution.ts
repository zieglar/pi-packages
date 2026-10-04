/**
 * Core execution vocabulary shared across the kernel: roles, tiers, thinking
 * levels, budgets, and persist-safe metadata. These are Wayforge-native types;
 * the Pi compatibility adapter maps them onto Pi/Pi-AI equivalents.
 */

/** Roles an invocation may run as. Phase 1A knows main, worker, advisor. */
export type InvocationRole = "main" | "worker" | "advisor";

/** Coarse model tiers a route may occupy. */
export type ModelTier = "flagship" | "balanced" | "fast" | "local";

/**
 * Thinking levels. Values intentionally align with Pi's thinking levels so
 * the compatibility adapter can pass them through without translation tables.
 */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Immutable snapshot of a context's budget state. */
export interface BudgetSnapshot {
  /** Hard cap for this context's subtree. */
  readonly limit: number;
  /** Consumption visible to the whole derivation tree (shared ledger). */
  readonly consumed: number;
  readonly remaining: number;
}

/** Values allowed in persist-safe trace metadata. */
export type PersistSafeValue = string | number | boolean | null;
