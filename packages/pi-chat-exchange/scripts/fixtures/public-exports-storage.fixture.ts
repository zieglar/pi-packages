// gate-fixture: public-exports-storage @role .
// Deliberate violation: the package public barrel must never expose private storage.
export * from "./storage/store.js";
