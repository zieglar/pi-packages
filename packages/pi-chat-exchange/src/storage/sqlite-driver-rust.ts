import type { NativeModuleInfo, SqliteAuthorizerPolicy, SqliteConnection, SqliteDriver, SqliteInputValue, SqliteRow, SqliteStatement } from "./sqlite-driver.js";

interface NativeConnectionLike {
  query(sql: string, parameters: unknown[], limit: number): [string[], unknown[][]];
  execute(sql: string, parameters: unknown[]): [number, number];
  prepareOnly(sql: string): void;
  exec(sql: string): void;
  isTransaction(): boolean;
  enableDefensive(enabled: boolean): void;
  setAuthorizerPolicy(policy: number): void;
  authorizerDenials(): number;
  close(): void;
}

interface NativeModuleLike {
  NativeConnection: new (path: string, options: { readOnly: boolean; defensive: boolean; timeout: number }) => NativeConnectionLike;
  abiVersion(): number;
  info(): string;
}

/** Capture-free factory. `requireFn` is supplied by the Host or child; the
 * native path must already be trusted/verified by the artifact manager. */
export function createRustNativeDriver(
  requireFn: (specifier: string) => unknown,
  nativePath: string,
): SqliteDriver {
  const native = requireFn(nativePath) as NativeModuleLike;
  let info: NativeModuleInfo;
  try {
    info = JSON.parse(native.info()) as NativeModuleInfo;
  } catch {
    throw Object.assign(new Error("native module returned invalid identity"), { code: "CE_NATIVE_INFO_INVALID" });
  }
  const stateError = (message: string): Error => Object.assign(new Error(message), { code: "ERR_INVALID_STATE" });
  const enrich = (caught: unknown): Error => {
    if (!(caught instanceof Error) || !caught.message.startsWith("\u0001CE_SQLITE")) {
      return caught instanceof Error ? caught : new Error(String(caught));
    }
    let payload: { kind?: string; code?: string | number; errstr?: string; message?: string };
    try {
      payload = JSON.parse(caught.message.slice("\u0001CE_SQLITE".length)) as { kind?: string; code?: string | number; errstr?: string; message?: string };
    } catch {
      return caught;
    }
    const error = new Error(payload.message ?? "SQLite driver failure");
    if (payload.kind === "sqlite") {
      Object.assign(error, { code: "ERR_SQLITE_ERROR", errcode: payload.code, errstr: payload.errstr });
    } else {
      Object.assign(error, { code: payload.kind === "state" ? "ERR_INVALID_STATE" : payload.kind === "range" ? "ERR_OUT_OF_RANGE" : payload.code });
    }
    return error;
  };
  const policyNumber = (policy: SqliteAuthorizerPolicy): number => policy === "off" ? 0 : policy === "deny-transaction-control" ? 1 : 2;

  return {
    kind: "rust-native",
    nativeInfo: info,
    nativePath,
    open(path, options = {}): SqliteConnection {
      let raw: NativeConnectionLike;
      try {
        raw = new native.NativeConnection(path, {
          readOnly: options.readOnly ?? false,
          defensive: options.defensive ?? true,
          timeout: options.timeout ?? 0,
        });
      } catch (error) { throw enrich(error); }
      let closed = false;
      let externalAuthorizer = false;
      const ensureOpen = (): void => { if (closed) throw stateError("database is not open"); };
      const call = <T>(operation: () => T): T => {
        try { return operation(); } catch (error) { throw enrich(error); }
      };
      const rowObject = (names: string[], values: unknown[] | undefined): SqliteRow | undefined => {
        if (values === undefined) return undefined;
        const row = Object.create(null) as SqliteRow;
        for (let index = 0; index < names.length; index += 1) row[names[index]!] = values[index] as SqliteRow[string];
        return row;
      };
      return {
        prepare(sql: string): SqliteStatement {
          ensureOpen();
          call(() => raw.prepareOnly(sql));
          return {
            get: (...parameters: SqliteInputValue[]): SqliteRow | undefined => {
              ensureOpen();
              const [names, rows] = call(() => raw.query(sql, parameters, 1));
              return rowObject(names, rows[0]);
            },
            all: (...parameters: SqliteInputValue[]): SqliteRow[] => {
              ensureOpen();
              const [names, rows] = call(() => raw.query(sql, parameters, 0xffffffff));
              return rows.map((row) => rowObject(names, row)!);
            },
            run: (...parameters: SqliteInputValue[]) => {
              ensureOpen();
              const [changes] = call(() => raw.execute(sql, parameters));
              return { changes };
            },
          };
        },
        exec(sql: string): void { ensureOpen(); call(() => raw.exec(sql)); },
        close(): void {
          ensureOpen();
          try { call(() => raw.close()); } finally {
            closed = true;
          }
        },
        get isTransaction(): boolean { ensureOpen(); return call(() => raw.isTransaction()); },
        enableDefensive(enabled: boolean): void { ensureOpen(); call(() => raw.enableDefensive(enabled)); },
        setAuthorizer(callback: ((action: number) => number) | null): void {
          ensureOpen();
          externalAuthorizer = true;
          call(() => raw.setAuthorizerPolicy(callback === null ? 0 : 2));
        },
        setAuthorizerPolicy(policy: SqliteAuthorizerPolicy): void {
          ensureOpen();
          if (policy === "off" && externalAuthorizer) return;
          externalAuthorizer = false;
          call(() => raw.setAuthorizerPolicy(policyNumber(policy)));
        },
        authorizerDenials(): number { ensureOpen(); return externalAuthorizer ? 0 : call(() => raw.authorizerDenials()); },
      };
    },
  };
}
