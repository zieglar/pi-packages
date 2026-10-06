/**
 * Versioned, extension-neutral protocol client for Pi Accounts.
 *
 * This boundary validates untrusted EventBus callbacks and deliberately owns
 * neither account selection nor recovery policy. It has no dependency on the
 * pi-accounts package or implementation.
 */

export interface EventBusPort {
  emit(channel: string, data: unknown): void;
}

export const ACCOUNTS_TOPOLOGY_CHANNEL = "accounts:topology:v1";
export const ACCOUNTS_ACTIVATION_CHANNEL = "accounts:activation:v1";

const ACTIVATION_ERROR_CODES = new Set([
  "account_not_found",
  "authentication_failed",
  "store_unavailable",
  "effective_auth_conflict",
  "model_unavailable",
  "activation_superseded",
  "session_unavailable",
  "provider_unsupported",
  "cancelled",
  "activation_failed",
]);

export type AccountCredentialKind = "oauth" | "api-key";
export type ActivationErrorCode =
  | "account_not_found"
  | "authentication_failed"
  | "store_unavailable"
  | "effective_auth_conflict"
  | "model_unavailable"
  | "activation_superseded"
  | "session_unavailable"
  | "provider_unsupported"
  | "cancelled"
  | "activation_failed";

export interface AccountTopology {
  readonly providers: readonly AccountProvider[];
}

export interface AccountProvider {
  readonly providerId: string;
  readonly displayName: string;
  readonly accounts: readonly AccountInventoryItem[];
  readonly defaultAccount?: string;
}

export interface AccountInventoryItem {
  readonly name: string;
  readonly kind: AccountCredentialKind;
}

export type ProtocolFailure = {
  readonly status: "protocol_failure";
  readonly code: "timeout" | "cancelled" | "malformed_reply";
};

export type TopologyOutcome =
  | { readonly status: "topology"; readonly topology: AccountTopology }
  | ProtocolFailure;

export type ActivationOutcome =
  | { readonly status: "active"; readonly providerId: string; readonly accountName: string }
  | { readonly status: "inactive"; readonly providerId: string; readonly accountName: null }
  | { readonly status: "error"; readonly providerId: string; readonly accountName: string | null; readonly code: ActivationErrorCode }
  | ProtocolFailure;

export interface ActivateAccountRequest {
  /** Exact live Pi session object; never a serializable session identifier. */
  readonly session: object;
  readonly provider: string;
  /** null restores Pi built-in authentication; it never selects defaultAccount. */
  readonly account: string | null;
  readonly model?: string;
  readonly signal?: AbortSignal;
}

export interface PiAccountsAdapterOptions {
  /** Local wait bound for callback-only EventBus protocols. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export class PiAccountsAdapter {
  private readonly timeoutMs: number;

  constructor(
    private readonly events: EventBusPort,
    options: PiAccountsAdapterOptions = {},
  ) {
    this.timeoutMs = validTimeout(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  }

  topology(signal?: AbortSignal): Promise<TopologyOutcome> {
    return this.waitForReply<TopologyOutcome>(
      signal,
      (settle) => this.events.emit(ACCOUNTS_TOPOLOGY_CHANNEL, {
        reply: (value: unknown) => settle(safelyValidate(validateTopology, value)),
      }),
    );
  }

  activate(request: ActivateAccountRequest): Promise<ActivationOutcome> {
    if (request.signal?.aborted === true) return Promise.resolve(cancelled());
    return this.waitForReply<ActivationOutcome>(
      request.signal,
      (settle) => this.events.emit(ACCOUNTS_ACTIVATION_CHANNEL, {
        session: request.session,
        provider: request.provider,
        account: request.account,
        ...(request.model !== undefined ? { model: request.model } : {}),
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
        reply: (value: unknown) => settle(safelyValidate(validateActivation, value)),
      }),
    );
  }

  private waitForReply<T>(
    signal: AbortSignal | undefined,
    emit: (settle: (outcome: T) => void) => void,
  ): Promise<T> {
    if (signal?.aborted === true) return Promise.resolve(cancelled() as T);
    return new Promise<T>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => settle(cancelled() as T);
      const settle = (outcome: T) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => settle(timeout() as T), this.timeoutMs);
      try {
        emit(settle);
      } catch {
        settle(malformedReply() as T);
      }
    });
  }
}

function validTimeout(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateTopology(value: unknown): TopologyOutcome {
  if (!isRecord(value) || !Array.isArray(value.providers)) return malformedReply();
  const providers: AccountProvider[] = [];
  for (const candidate of value.providers) {
    if (!isRecord(candidate) || !nonEmptyString(candidate.providerId) || !nonEmptyString(candidate.displayName) || !Array.isArray(candidate.accounts)) {
      return malformedReply();
    }
    if (candidate.defaultAccount !== undefined && !nonEmptyString(candidate.defaultAccount)) return malformedReply();
    const accounts: AccountInventoryItem[] = [];
    for (const account of candidate.accounts) {
      if (!isRecord(account) || !nonEmptyString(account.name) || (account.kind !== "oauth" && account.kind !== "api-key")) {
        return malformedReply();
      }
      accounts.push({ name: account.name, kind: account.kind });
    }
    providers.push({
      providerId: candidate.providerId,
      displayName: candidate.displayName,
      accounts,
      ...(candidate.defaultAccount !== undefined ? { defaultAccount: candidate.defaultAccount } : {}),
    });
  }
  return { status: "topology", topology: { providers } };
}

function validateActivation(value: unknown): ActivationOutcome {
  if (!isRecord(value) || !nonEmptyString(value.status) || !nonEmptyString(value.providerId)) return malformedReply();
  if (value.status === "active") {
    return nonEmptyString(value.accountName)
      ? { status: "active", providerId: value.providerId, accountName: value.accountName }
      : malformedReply();
  }
  if (value.status === "inactive") {
    return value.accountName === null
      ? { status: "inactive", providerId: value.providerId, accountName: null }
      : malformedReply();
  }
  if (value.status === "error") {
    if ((value.accountName !== null && !nonEmptyString(value.accountName)) ||
      !nonEmptyString(value.code) || !ACTIVATION_ERROR_CODES.has(value.code)) return malformedReply();
    return { status: "error", providerId: value.providerId, accountName: value.accountName, code: value.code as ActivationErrorCode };
  }
  return malformedReply();
}

function safelyValidate<T>(validator: (value: unknown) => T, value: unknown): T | ProtocolFailure {
  try {
    return validator(value);
  } catch {
    return malformedReply();
  }
}

function timeout(): ProtocolFailure {
  return { status: "protocol_failure", code: "timeout" };
}

function cancelled(): ProtocolFailure {
  return { status: "protocol_failure", code: "cancelled" };
}

function malformedReply(): ProtocolFailure {
  return { status: "protocol_failure", code: "malformed_reply" };
}
