import { createHash } from "node:crypto";

export const APPLICATION_ID = "@zieglar/pi-chat-exchange";
export const SQLITE_APPLICATION_ID = 0x50434558; // "PCEX"
export const CURRENT_SCHEMA_VERSION = 2;
export const INITIAL_MIGRATION_NAME = "durable-storage-foundation";
export const V2_MIGRATION_NAME = "b3-communication-lifecycle-migration";
export const V2_FOUNDATION_NAME = "b3-communication-lifecycle-foundation";

const REVISION = "private_revision INTEGER NOT NULL DEFAULT 1 CHECK (private_revision >= 1)";

export const INITIAL_SCHEMA_SQL = `
CREATE TABLE store_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  store_uuid TEXT NOT NULL UNIQUE,
  application_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version >= 1),
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE restore_hold (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  held INTEGER NOT NULL DEFAULT 0 CHECK (held IN (0, 1)),
  reason TEXT,
  detected_at TEXT,
  CHECK ((held = 0 AND reason IS NULL AND detected_at IS NULL) OR
         (held = 1 AND length(reason) > 0 AND detected_at IS NOT NULL))
) STRICT;

CREATE TABLE exchange (
  exchange_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('OPEN', 'CLOSED')),
  created_at TEXT NOT NULL,
  closed_at TEXT,
  ${REVISION},
  CHECK ((state = 'OPEN' AND closed_at IS NULL) OR (state = 'CLOSED' AND closed_at IS NOT NULL))
) STRICT;

CREATE TABLE message (
  message_id TEXT PRIMARY KEY,
  exchange_id TEXT NOT NULL REFERENCES exchange(exchange_id) ON DELETE RESTRICT,
  from_endpoint_json TEXT NOT NULL CHECK (json_valid(from_endpoint_json) AND json_type(from_endpoint_json) = 'object'),
  to_endpoint_json TEXT NOT NULL CHECK (json_valid(to_endpoint_json) AND json_type(to_endpoint_json) = 'object'),
  state TEXT NOT NULL CHECK (state IN (
    'CREATED', 'QUEUED', 'CLAIMED', 'DISPATCHING', 'ACCEPTED', 'RUNNING', 'SETTLED',
    'RESULT_AVAILABLE', 'DELIVERY_UNKNOWN', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED'
  )),
  payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
  payload_length INTEGER NOT NULL CHECK (payload_length >= 0),
  payload_body BLOB,
  created_at TEXT NOT NULL,
  idempotency_key TEXT,
  ${REVISION},
  UNIQUE (exchange_id, message_id),
  UNIQUE (exchange_id, idempotency_key)
) STRICT;

CREATE TABLE attempt (
  attempt_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES message(message_id) ON DELETE RESTRICT,
  endpoint_json TEXT NOT NULL CHECK (json_valid(endpoint_json) AND json_type(endpoint_json) = 'object'),
  consumer_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  lease_expires_at TEXT NOT NULL,
  dispatch TEXT NOT NULL CHECK (dispatch IN ('not_attempted', 'started')),
  transport TEXT NOT NULL CHECK (transport IN ('pending', 'delivered', 'ambiguous', 'failed')),
  created_at TEXT NOT NULL,
  ${REVISION},
  UNIQUE (message_id, attempt_id)
) STRICT;

CREATE TABLE current_claim (
  message_id TEXT PRIMARY KEY REFERENCES message(message_id) ON DELETE RESTRICT,
  consumer_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  expires_at TEXT NOT NULL,
  ${REVISION}
) STRICT;

CREATE TABLE fencing_high_water (
  message_id TEXT PRIMARY KEY REFERENCES message(message_id) ON DELETE RESTRICT,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  ${REVISION}
) STRICT;

CREATE TABLE result (
  result_id TEXT PRIMARY KEY,
  exchange_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  attempt_id TEXT NOT NULL UNIQUE,
  source_endpoint_json TEXT NOT NULL CHECK (json_valid(source_endpoint_json) AND json_type(source_endpoint_json) = 'object'),
  transport TEXT NOT NULL CHECK (transport IN ('delivered', 'ambiguous', 'failed')),
  runtime TEXT NOT NULL CHECK (runtime IN ('accepted', 'running', 'settled', 'runtime_error', 'cancelled', 'interrupted')),
  body TEXT NOT NULL,
  result_digest TEXT NOT NULL CHECK (length(result_digest) = 64),
  settled_at TEXT NOT NULL,
  ${REVISION},
  FOREIGN KEY (exchange_id, message_id) REFERENCES message(exchange_id, message_id) ON DELETE RESTRICT,
  FOREIGN KEY (message_id, attempt_id) REFERENCES attempt(message_id, attempt_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE idempotency_record (
  namespace TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  entity_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ${REVISION},
  PRIMARY KEY (namespace, idempotency_key)
) STRICT;

CREATE TABLE evidence_envelope (
  envelope_id TEXT PRIMARY KEY,
  exchange_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  evidence_kind TEXT NOT NULL,
  evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  observed_at TEXT NOT NULL,
  ${REVISION},
  FOREIGN KEY (exchange_id, message_id) REFERENCES message(exchange_id, message_id) ON DELETE RESTRICT,
  FOREIGN KEY (message_id, attempt_id) REFERENCES attempt(message_id, attempt_id) ON DELETE RESTRICT,
  UNIQUE (attempt_id, evidence_kind, evidence_digest)
) STRICT;

CREATE TABLE evidence_application (
  application_id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL UNIQUE REFERENCES evidence_envelope(envelope_id) ON DELETE RESTRICT,
  result_id TEXT REFERENCES result(result_id) ON DELETE RESTRICT,
  application_json TEXT NOT NULL CHECK (json_valid(application_json)),
  applied_at TEXT NOT NULL,
  ${REVISION}
) STRICT;

CREATE TABLE reconciliation (
  reconciliation_id TEXT PRIMARY KEY,
  exchange_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  evidence_envelope_id TEXT NOT NULL UNIQUE REFERENCES evidence_envelope(envelope_id) ON DELETE RESTRICT,
  basis TEXT NOT NULL CHECK (length(basis) > 0),
  resolved_at TEXT NOT NULL,
  ${REVISION},
  FOREIGN KEY (exchange_id, message_id) REFERENCES message(exchange_id, message_id) ON DELETE RESTRICT,
  FOREIGN KEY (message_id, attempt_id) REFERENCES attempt(message_id, attempt_id) ON DELETE RESTRICT,
  UNIQUE (message_id)
) STRICT;

CREATE TABLE disposition (
  exchange_id TEXT PRIMARY KEY REFERENCES exchange(exchange_id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status = 'ABANDONED_UNRESOLVED'),
  owner_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) > 0),
  reconciliation_id TEXT NOT NULL UNIQUE REFERENCES reconciliation(reconciliation_id) ON DELETE RESTRICT,
  unresolved_json TEXT NOT NULL CHECK (json_valid(unresolved_json) AND json_type(unresolved_json) = 'array'),
  ${REVISION}
) STRICT;

CREATE TABLE audit_event (
  event_id TEXT PRIMARY KEY,
  exchange_id TEXT NOT NULL REFERENCES exchange(exchange_id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  digest TEXT CHECK (digest IS NULL OR length(digest) = 64),
  length INTEGER CHECK (length IS NULL OR length >= 0),
  outcome TEXT,
  ${REVISION},
  UNIQUE (exchange_id, sequence)
) STRICT;

CREATE INDEX idx_message_exchange ON message(exchange_id, created_at);
CREATE INDEX idx_attempt_message ON attempt(message_id, created_at);
CREATE INDEX idx_result_correlation ON result(exchange_id, message_id, attempt_id);
CREATE INDEX idx_evidence_envelope_correlation ON evidence_envelope(exchange_id, message_id, attempt_id);
CREATE INDEX idx_reconciliation_message ON reconciliation(message_id, attempt_id);
CREATE INDEX idx_audit_event_exchange ON audit_event(exchange_id, sequence);

CREATE TRIGGER store_metadata_immutable
BEFORE UPDATE ON store_metadata BEGIN SELECT RAISE(ABORT, 'store metadata is immutable'); END;
CREATE TRIGGER store_metadata_nodelete
BEFORE DELETE ON store_metadata BEGIN SELECT RAISE(ABORT, 'store metadata is immutable'); END;
CREATE TRIGGER schema_migrations_immutable
BEFORE UPDATE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'migration ledger is immutable'); END;
CREATE TRIGGER schema_migrations_nodelete
BEFORE DELETE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'migration ledger is immutable'); END;

CREATE TRIGGER exchange_identity_immutable
BEFORE UPDATE OF exchange_id ON exchange
WHEN NEW.exchange_id IS NOT OLD.exchange_id
BEGIN SELECT RAISE(ABORT, 'exchange identity is immutable'); END;
CREATE TRIGGER message_identity_immutable
BEFORE UPDATE OF message_id, exchange_id ON message
WHEN NEW.message_id IS NOT OLD.message_id OR NEW.exchange_id IS NOT OLD.exchange_id
BEGIN SELECT RAISE(ABORT, 'message identity is immutable'); END;
CREATE TRIGGER attempt_identity_immutable
BEFORE UPDATE OF attempt_id, message_id ON attempt
WHEN NEW.attempt_id IS NOT OLD.attempt_id OR NEW.message_id IS NOT OLD.message_id
BEGIN SELECT RAISE(ABORT, 'attempt identity is immutable'); END;
CREATE TRIGGER current_claim_identity_immutable
BEFORE UPDATE OF message_id ON current_claim
WHEN NEW.message_id IS NOT OLD.message_id
BEGIN SELECT RAISE(ABORT, 'claim identity is immutable'); END;
CREATE TRIGGER fencing_high_water_identity_immutable
BEFORE UPDATE OF message_id ON fencing_high_water
WHEN NEW.message_id IS NOT OLD.message_id
BEGIN SELECT RAISE(ABORT, 'fencing identity is immutable'); END;

CREATE TRIGGER result_immutable
BEFORE UPDATE ON result BEGIN SELECT RAISE(ABORT, 'result is immutable'); END;
CREATE TRIGGER result_nodelete
BEFORE DELETE ON result BEGIN SELECT RAISE(ABORT, 'result is immutable'); END;
CREATE TRIGGER audit_event_immutable
BEFORE UPDATE ON audit_event BEGIN SELECT RAISE(ABORT, 'audit event is immutable'); END;
CREATE TRIGGER audit_event_nodelete
BEFORE DELETE ON audit_event BEGIN SELECT RAISE(ABORT, 'audit event is immutable'); END;
`;

export const INITIAL_MIGRATION_CHECKSUM = createHash("sha256")
  .update(INITIAL_SCHEMA_SQL, "utf8")
  .digest("hex");

/**
 * B3 additive schema-v2 surface (CE-0002-B3-P1A). Every v1 table, trigger,
 * index, and row is preserved byte-identically; v2 only appends new objects.
 * `store_metadata` and the v1 ledger row are never UPDATEd or DELETEd: the
 * accepted v1 immutability triggers make that impossible, and the explicit
 * migration relies on them. The ownership/fencing/cursor tables are inert
 * schema in P1A — no code path reads or writes them before B3-P2/P3.
 */
export const V2_ADDITIVE_SQL = `
CREATE TABLE participant (
  participant_id TEXT PRIMARY KEY,
  endpoint_adapter TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ${REVISION},
  UNIQUE (endpoint_adapter, endpoint_id)
) STRICT;

CREATE TABLE participant_capability (
  capability_digest TEXT PRIMARY KEY CHECK (length(capability_digest) = 64),
  participant_id TEXT NOT NULL REFERENCES participant(participant_id) ON DELETE RESTRICT,
  scope TEXT NOT NULL CHECK (scope IN ('create', 'bind', 'join', 'attach', 'resume', 'takeover', 'send', 'ack', 'read')),
  trust_generation INTEGER NOT NULL CHECK (trust_generation >= 1),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  ${REVISION}
) STRICT;

CREATE TABLE participant_session (
  participant_id TEXT NOT NULL REFERENCES participant(participant_id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL,
  bound_at TEXT NOT NULL,
  detached_at TEXT,
  ${REVISION},
  PRIMARY KEY (participant_id, session_id)
) STRICT;

CREATE TABLE exchange_membership (
  exchange_id TEXT NOT NULL REFERENCES exchange(exchange_id) ON DELETE RESTRICT,
  participant_id TEXT NOT NULL REFERENCES participant(participant_id) ON DELETE RESTRICT,
  join_boundary_seq INTEGER NOT NULL CHECK (join_boundary_seq >= 1),
  created_at TEXT NOT NULL,
  ${REVISION},
  PRIMARY KEY (exchange_id, participant_id)
) STRICT;

CREATE TABLE participant_ownership (
  participant_id TEXT PRIMARY KEY REFERENCES participant(participant_id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  expires_at TEXT NOT NULL,
  ${REVISION}
) STRICT;

CREATE TABLE participant_fencing_high_water (
  participant_id TEXT PRIMARY KEY REFERENCES participant(participant_id) ON DELETE RESTRICT,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  ${REVISION}
) STRICT;

CREATE TABLE delivery_cursor (
  exchange_id TEXT NOT NULL REFERENCES exchange(exchange_id) ON DELETE RESTRICT,
  participant_id TEXT NOT NULL REFERENCES participant(participant_id) ON DELETE RESTRICT,
  acked_audit_seq INTEGER NOT NULL CHECK (acked_audit_seq >= 0),
  ${REVISION},
  PRIMARY KEY (exchange_id, participant_id)
) STRICT;

CREATE TABLE host_trust_root (
  generation INTEGER PRIMARY KEY CHECK (generation >= 1),
  secret_digest TEXT NOT NULL CHECK (length(secret_digest) = 64),
  created_at TEXT NOT NULL,
  ${REVISION}
) STRICT;

CREATE TRIGGER participant_identity_immutable
BEFORE UPDATE OF participant_id, endpoint_adapter, endpoint_id ON participant
WHEN NEW.participant_id IS NOT OLD.participant_id
  OR NEW.endpoint_adapter IS NOT OLD.endpoint_adapter
  OR NEW.endpoint_id IS NOT OLD.endpoint_id
BEGIN SELECT RAISE(ABORT, 'participant identity and binding are immutable'); END;

CREATE TRIGGER exchange_membership_immutable
BEFORE UPDATE ON exchange_membership BEGIN SELECT RAISE(ABORT, 'exchange membership is immutable'); END;
CREATE TRIGGER exchange_membership_nodelete
BEFORE DELETE ON exchange_membership BEGIN SELECT RAISE(ABORT, 'exchange membership is immutable'); END;

CREATE TRIGGER host_trust_root_immutable
BEFORE UPDATE ON host_trust_root BEGIN SELECT RAISE(ABORT, 'host trust root is append-only'); END;
CREATE TRIGGER host_trust_root_nodelete
BEFORE DELETE ON host_trust_root BEGIN SELECT RAISE(ABORT, 'host trust root is append-only'); END;
`;

export const V2_MIGRATION_CHECKSUM = createHash("sha256")
  .update(V2_ADDITIVE_SQL, "utf8")
  .digest("hex");

/** A fresh v2 initialization applies exactly the v1 schema plus the additive
 * v2 surface, so migrated and freshly initialized stores converge to one
 * byte-identical schema manifest. */
export const V2_FOUNDATION_SQL = INITIAL_SCHEMA_SQL + V2_ADDITIVE_SQL;

export const V2_FOUNDATION_CHECKSUM = createHash("sha256")
  .update(V2_FOUNDATION_SQL, "utf8")
  .digest("hex");
