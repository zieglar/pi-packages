/**
 * Public library surface of pi-chat-exchange: the frozen protocol contracts
 * and the pure core rules (plus the in-memory idempotency reference).
 * Adapters are internal seams and are deliberately not re-exported here;
 * `src/bin` composes the MCP smoke entrypoint.
 */
export * from "./protocol/index.js";
export * from "./core/rules.js";
export * from "./core/reference.js";
