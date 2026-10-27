// @role protocol
// @ts-expect-error virtual-role fixture: gate resolves this export from src/protocol
export { PI_ADAPTER_KIND as forbiddenOuterDependency } from "../endpoints/pi/contract.js";
