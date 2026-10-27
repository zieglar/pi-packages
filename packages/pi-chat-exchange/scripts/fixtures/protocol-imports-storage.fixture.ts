// gate-fixture: protocol-imports-storage @role protocol
// Deliberate violation: protocol must never depend on private storage.
import { openStore } from "../storage/store.js";

export const violatesStorageBoundary = openStore;
