import { isSensitiveKey } from "../trace/redaction.js";
import type { FailureMetadata } from "../types/result.js";

/**
 * Sanitized health record. Credentials and raw provider responses are
 * rejected before they can enter a record.
 */
export interface HealthRecord {
  readonly key: string;
  readonly kind: "route" | "account" | "provider" | "model";
  readonly status: "available" | "cooldown" | "suspended" | "unavailable";
  readonly updatedAtMs: number;
  readonly cooldownUntilMs?: number;
  readonly metadata?: FailureMetadata;
}

export interface HealthUpdate {
  readonly status: HealthRecord["status"];
  readonly cooldownMs?: number;
  readonly updatedAtMs?: number;
  readonly metadata?: FailureMetadata;
}

const keyOf = (kind: HealthRecord["kind"], id: string) => `${kind}:${id}`;

/**
 * Single owner of sanitized route/account/provider/model cooldown and
 * availability state. Phase 1A implementation is in-memory and deterministic
 * via an injected clock; it is the one cooldown boundary in the kernel.
 */
export class HealthRegistry {
  private readonly records = new Map<string, HealthRecord>();

  constructor(private readonly now: () => number = () => 0) {}

  private assertSafeMetadata(metadata: FailureMetadata | undefined): void {
    if (!metadata) return;
    for (const key of Object.keys(metadata)) {
      if (isSensitiveKey(key)) {
        throw new Error(
          `secret-bearing or raw provider metadata is forbidden in health records: ${key}`,
        );
      }
    }
  }

  private record(kind: HealthRecord["kind"], id: string, update: HealthUpdate): void {
    this.assertSafeMetadata(update.metadata);
    const updatedAtMs = update.updatedAtMs ?? this.now();
    const cooldownUntilMs =
      update.cooldownMs !== undefined ? Math.max(updatedAtMs, updatedAtMs + update.cooldownMs) : undefined;
    const existing = this.records.get(keyOf(kind, id));
    this.records.set(keyOf(kind, id), {
      key: keyOf(kind, id),
      kind,
      status: update.status,
      updatedAtMs,
      ...(cooldownUntilMs !== undefined ? { cooldownUntilMs } : {}),
      ...(existing?.metadata !== undefined || update.metadata !== undefined
        ? { metadata: { ...existing?.metadata, ...update.metadata } }
        : {}),
    });
  }

  recordRoute(id: string, update: HealthUpdate): void {
    this.record("route", id, update);
  }
  recordAccount(id: string, update: HealthUpdate): void {
    this.record("account", id, update);
  }
  recordProvider(id: string, update: HealthUpdate): void {
    this.record("provider", id, update);
  }
  recordModel(id: string, update: HealthUpdate): void {
    this.record("model", id, update);
  }

  get(key: string): HealthRecord | undefined {
    return this.records.get(key);
  }

  getRoute(id: string): HealthRecord | undefined {
    return this.records.get(keyOf("route", id));
  }
  getAccount(id: string): HealthRecord | undefined {
    return this.records.get(keyOf("account", id));
  }
  getProvider(id: string): HealthRecord | undefined {
    return this.records.get(keyOf("provider", id));
  }
  getModel(id: string): HealthRecord | undefined {
    return this.records.get(keyOf("model", id));
  }

  /** Central cooldown check: unknown keys are available; cooldowns expire with the clock. */
  isAvailable(key: string): boolean {
    const kinds: readonly HealthRecord["kind"][] = ["route", "account", "provider", "model"];
    for (const kind of kinds) {
      const record = this.records.get(keyOf(kind, key));
      if (record) return HealthRegistry.evaluate(record, this.now());
    }
    const direct = this.records.get(key);
    if (direct) return HealthRegistry.evaluate(direct, this.now());
    return true;
  }

  private static evaluate(record: HealthRecord, now: number): boolean {
    if (record.status === "available") return true;
    if (record.cooldownUntilMs !== undefined && record.cooldownUntilMs <= now) return true;
    return false;
  }

  /** Sanitized snapshot for planning; never contains secrets by construction. */
  snapshot(): readonly HealthRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }
}
