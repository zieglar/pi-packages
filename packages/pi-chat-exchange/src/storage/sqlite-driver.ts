/** Minimal SQLite-only synchronous driver boundary. No ORM and no multi-database
 * abstraction. Business transactions and recovery remain in TypeScript. */

export type SqliteInputValue = string | number | null | Uint8Array;
export type SqliteOutputValue = string | number | null | Uint8Array;
export type SqliteRow = Record<string, SqliteOutputValue>;

export interface SqliteStatement {
  get(...parameters: SqliteInputValue[]): SqliteRow | undefined;
  all(...parameters: SqliteInputValue[]): SqliteRow[];
  run(...parameters: SqliteInputValue[]): { changes: number };
}

/** Parsed-action policy implemented inside the driver; never a JS authorizer
 * callback that could re-enter SQLite. */
export type SqliteAuthorizerPolicy = "off" | "deny-transaction-control" | "deny-all";

export interface SqliteConnection {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
  /** Throws when the connection is closed or unreadable; never guessed. */
  readonly isTransaction: boolean;
  enableDefensive(enabled: boolean): void;
  setAuthorizer(callback: ((action: number) => number) | null): void;
  setAuthorizerPolicy(policy: SqliteAuthorizerPolicy): void;
  authorizerDenials(): number;
}

export interface SqliteOpenOptions {
  readonly readOnly?: boolean;
  readonly defensive?: boolean;
  readonly timeout?: number;
}

export interface NativeModuleInfo {
  readonly middlewareVersion: string;
  readonly abiVersion: number;
  readonly target: string;
  readonly buildId: string;
  readonly rustc: string;
  readonly sqliteVersion: string;
  readonly sqliteSourceId: string;
}

export interface SqliteDriver {
  readonly kind: "node-sqlite" | "rust-native";
  readonly nativeInfo?: NativeModuleInfo;
  readonly nativePath?: string;
  open(path: string, options?: SqliteOpenOptions): SqliteConnection;
}
