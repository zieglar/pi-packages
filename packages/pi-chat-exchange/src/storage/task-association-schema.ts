import { createHash } from "node:crypto";
import { V7_FOUNDATION_SQL } from "./current-schema.js";

// A permit exists only inside a v8 writer transaction. SQLite serializes writers,
// so connections opened by older code cannot borrow another transaction's permit.
const V8_GUARDED_TABLES = ["store_metadata", "schema_migrations", "restore_hold", "exchange", "message", "attempt", "current_claim", "fencing_high_water", "result", "idempotency_record", "evidence_envelope", "evidence_application", "reconciliation", "disposition", "audit_event", "participant", "participant_capability", "participant_session", "exchange_membership", "participant_ownership", "participant_fencing_high_water", "delivery_cursor", "host_trust_root", "delivery_ack_receipt", "message_association", "native_session_binding", "selected_session_binding"] as const;
const V8_WRITER_GUARDS = `CREATE TABLE v8_write_permit (singleton INTEGER PRIMARY KEY CHECK (singleton=1)) STRICT;\n` +
  V8_GUARDED_TABLES.flatMap(table => ["INSERT", "UPDATE", "DELETE"].map(operation =>
    `CREATE TRIGGER v8_guard_${table}_${operation.toLowerCase()} BEFORE ${operation} ON ${table} WHEN NOT EXISTS (SELECT 1 FROM v8_write_permit WHERE singleton=1) BEGIN SELECT RAISE(ABORT, 'v8 writer required'); END;`)).join("\n");

/** The association is private metadata; the frozen public Message is unchanged. */
export const V8_ASSOCIATION_SQL = `
CREATE TABLE message_association (
  message_id TEXT PRIMARY KEY,
  exchange_id TEXT NOT NULL,
  request_message_id TEXT NOT NULL,
  from_endpoint_json TEXT NOT NULL CHECK (json_valid(from_endpoint_json) AND json_type(from_endpoint_json) = 'object'),
  to_endpoint_json TEXT NOT NULL CHECK (json_valid(to_endpoint_json) AND json_type(to_endpoint_json) = 'object'),
  policy_id TEXT,
  selection_version INTEGER CHECK (selection_version IS NULL OR selection_version >= 1),
  target_runtime_session_id TEXT,
  binding_epoch INTEGER CHECK (binding_epoch IS NULL OR binding_epoch >= 1),
  target_owner_session_id TEXT,
  target_owner_fencing_token INTEGER CHECK (target_owner_fencing_token IS NULL OR target_owner_fencing_token >= 1),
  created_at TEXT NOT NULL,
  FOREIGN KEY (exchange_id, message_id) REFERENCES message(exchange_id, message_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (exchange_id, request_message_id) REFERENCES message(exchange_id, message_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE native_session_binding (
  participant_id TEXT NOT NULL REFERENCES participant(participant_id),
  session_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  runtime_session_id TEXT NOT NULL,
  binding_epoch INTEGER NOT NULL CHECK (binding_epoch >= 1),
  PRIMARY KEY(participant_id, session_id, fencing_token)
 ) STRICT;
CREATE TABLE selected_session_binding (
  policy_id TEXT NOT NULL,
  selection_version INTEGER NOT NULL,
  participant_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  runtime_session_id TEXT NOT NULL,
  binding_epoch INTEGER NOT NULL,
  PRIMARY KEY(policy_id, selection_version)
 ) STRICT;
CREATE INDEX idx_message_association_request ON message_association(exchange_id, request_message_id, message_id);
CREATE TRIGGER native_session_binding_immutable BEFORE UPDATE ON native_session_binding
BEGIN SELECT RAISE(ABORT, 'native binding is immutable'); END;
CREATE TRIGGER native_session_binding_nodelete BEFORE DELETE ON native_session_binding
BEGIN SELECT RAISE(ABORT, 'native binding is immutable'); END;
CREATE TRIGGER selected_session_binding_immutable BEFORE UPDATE ON selected_session_binding
BEGIN SELECT RAISE(ABORT, 'selection binding is immutable'); END;
CREATE TRIGGER selected_session_binding_nodelete BEFORE DELETE ON selected_session_binding
BEGIN SELECT RAISE(ABORT, 'selection binding is immutable'); END;
CREATE TRIGGER message_association_immutable BEFORE UPDATE ON message_association
BEGIN SELECT RAISE(ABORT, 'message association is immutable'); END;
CREATE TRIGGER message_association_nodelete BEFORE DELETE ON message_association
BEGIN SELECT RAISE(ABORT, 'message association is immutable'); END;
CREATE TRIGGER message_association_required BEFORE INSERT ON message
WHEN NOT EXISTS (SELECT 1 FROM message_association a WHERE a.message_id = NEW.message_id
  AND a.exchange_id = NEW.exchange_id AND a.from_endpoint_json = NEW.from_endpoint_json
  AND a.to_endpoint_json = NEW.to_endpoint_json)
BEGIN SELECT RAISE(ABORT, 'message association required'); END;
CREATE TRIGGER message_endpoints_immutable BEFORE UPDATE OF from_endpoint_json, to_endpoint_json ON message
WHEN NEW.from_endpoint_json IS NOT OLD.from_endpoint_json OR NEW.to_endpoint_json IS NOT OLD.to_endpoint_json
BEGIN SELECT RAISE(ABORT, 'message endpoints are immutable'); END;
` + V8_WRITER_GUARDS;
export const V8_FOUNDATION_SQL = V7_FOUNDATION_SQL + V8_ASSOCIATION_SQL;
export const V8_FOUNDATION_NAME = "direct-current-message-association";
export const V8_FOUNDATION_CHECKSUM = createHash("sha256").update(V8_FOUNDATION_SQL, "utf8").digest("hex");
export const V8_MIGRATION_NAME = "v7-to-v8-message-association";
export const V8_MIGRATION_CHECKSUM = createHash("sha256").update(V8_ASSOCIATION_SQL, "utf8").digest("hex");
