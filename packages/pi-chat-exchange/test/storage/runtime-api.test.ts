import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRuntimeIdentity, RuntimeEligibilityError } from "../../src/storage/runtime.js";

const fault = vi.hoisted(() => ({ transactionState: false }));
vi.mock("node:sqlite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:sqlite")>();
  return {
    ...actual,
    DatabaseSync: class extends actual.DatabaseSync {
      constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
        super(...args);
        // isTransaction is a non-configurable own getter, not a prototype API.
        if (fault.transactionState) return new Proxy(this, {
          get(target, key) {
            if (key === "isTransaction") return false;
            const value: unknown = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      }
    },
  };
});
afterEach(() => { vi.restoreAllMocks(); fault.transactionState = false; });

describe("in-memory runtime API qualification fails closed", () => {
  it("refuses a missing defensive API", () => {
    vi.spyOn(DatabaseSync.prototype, "enableDefensive").mockImplementation(() => { throw new TypeError("unavailable"); });
    expect(readRuntimeIdentity).toThrow(RuntimeEligibilityError);
  });
  it("refuses a defensive API that leaves defensive mode disabled", () => {
    const enableDefensive = DatabaseSync.prototype.enableDefensive;
    vi.spyOn(DatabaseSync.prototype, "enableDefensive").mockImplementation(function (this: DatabaseSync) {
      enableDefensive.call(this, false);
    });
    expect(readRuntimeIdentity).toThrow(RuntimeEligibilityError);
  });
  it("refuses an abnormal transaction state API", () => {
    fault.transactionState = true;
    expect(readRuntimeIdentity).toThrow(RuntimeEligibilityError);
  });
  it("refuses unavailable statement APIs", () => {
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(() => { throw new TypeError("unavailable"); });
    expect(readRuntimeIdentity).toThrow(RuntimeEligibilityError);
  });
});
