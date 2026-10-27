// gate-fixture: core-imports-fs @role core
// Deliberate violation: pure core rules must remain independent of filesystem storage.
import { openSync } from "node:fs";

export const violatesFilesystemBoundary = openSync;
