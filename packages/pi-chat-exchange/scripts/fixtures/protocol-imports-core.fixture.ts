// gate-fixture: protocol-imports-core @role protocol
// Deliberate violation: a protocol module must never depend on core.
import { assertMessageTransition } from "../../src/core/rules.js";

export const violatesDirection = assertMessageTransition;
