/** Storage lifecycle refusal vocabulary (CE-0002-B1..B3-P1A). Fixed, sanitized
 * codes only: messages must never carry secret, digest, or capability material. */
export type StoreLifecycleErrorCode =
  | "STORAGE_ALREADY_INITIALIZED"
  | "STORAGE_CORRUPT"
  // CE-0002-B3-P2C-B: the capability plane reads the Session lifecycle row
  // strictly; an inconsistent Session binding surfaces with the same code
  // the ownership plane uses for the same durable defect, so one malformed
  // row classifies identically on every operational surface.
  | "STORAGE_OWNERSHIP_CORRUPT"
  | "STORAGE_FOREIGN_STORE"
  | "STORAGE_INCOMPATIBLE"
  | "STORAGE_MIGRATION_CHECKSUM_MISMATCH"
  | "STORAGE_MIGRATION_NOT_REQUIRED"
  | "STORAGE_MIGRATION_REQUIRED"
  | "STORAGE_RESTORE_HOLD"
  | "STORAGE_SCHEMA_TOO_NEW"
  | "STORAGE_TRUST_ROOT_AMBIGUOUS"
  | "STORAGE_TRUST_ROOT_INSECURE"
  | "STORAGE_TRUST_ROOT_MISMATCH"
  | "STORAGE_TRUST_ROOT_MISSING";

export class StoreLifecycleError extends Error {
  readonly code: StoreLifecycleErrorCode;

  constructor(code: StoreLifecycleErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StoreLifecycleError";
    this.code = code;
  }
}
