// gate-fixture: protocol-imports-sqlite @role protocol
// Deliberate violation: protocol must remain independent of the storage driver.
import { DatabaseSync } from "node:sqlite";

export const violatesDriverBoundary = DatabaseSync;
