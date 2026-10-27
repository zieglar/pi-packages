// gate-fixture: core-imports-storage @role core
// Deliberate violation: pure core rules must never depend on private storage.
import { withImmediateTransaction } from "../storage/transaction.js";

export const violatesStorageBoundary = withImmediateTransaction;
