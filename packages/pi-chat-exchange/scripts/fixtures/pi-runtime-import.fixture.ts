// gate-fixture: pi-runtime-import @role endpoints/pi
// Deliberate violation: the Pi adapter is contracts-only; no runtime coupling.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ViolatesNoCoupling = ExtensionAPI;
