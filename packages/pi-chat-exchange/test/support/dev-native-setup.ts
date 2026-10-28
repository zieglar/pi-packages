import { resolveSqliteDriver } from "../../src/storage/sqlite-driver-selection.js";

// An explicit Rust lane must never pass by silently exercising the Node driver.
// The isolated HOME must contain a selection plus a pinned, cached local artifact.
const driver = resolveSqliteDriver();
if (driver.kind !== "rust-native") {
  throw new Error("Rust qualification requires an explicit rust-native selection and verified cache in the isolated HOME");
}
console.info(`CE Native qualification: ${driver.kind} ${driver.nativeInfo?.middlewareVersion} SQLite ${driver.nativeInfo?.sqliteVersion}`);
