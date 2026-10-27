/**
 * Public library surface of pi-chat-exchange: the frozen protocol contracts
 * and the pure core rules (plus the in-memory idempotency reference).
 * Control surfaces and endpoint integrations are internal seams, not re-exported;
 * `src/bin` composes the MCP smoke entrypoint.
 */
export * from "./protocol/index.js";
export * from "./core/rules.js";
export * from "./core/reference.js";
export * from "./core/authorization.js";
