import { createHash } from "node:crypto";
import { bindSession, acquireOwnership } from "../../../src/storage/ownership.js";
import { joinExchange } from "../../../src/storage/participant.js";
import { sendMessage } from "../../../src/storage/messaging.js";
import { fixture, exchange, participant, capabilityFor, NOW, reader, type Fixture } from "./participant-fixture.js";
export const S1 = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const S2 = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAW";
export const S3 = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAX";
export const SENDER = "ses_01ARZ3NDEKTSV4RRFFQ69G5FA0";
export const at = (seconds: number) => new Date(Date.parse(NOW) + seconds * 1000).toISOString();
export const clockAt = (seconds: number) => ({ now: () => at(seconds) });
export function ackWorld() {
  const f = fixture("ce-ack-v7-");
  const exchangeId = exchange(f);
  const recipient = participant(f, "ack-recipient").participant.participantId;
  const sender = participant(f, "ack-sender").participant.participantId;
  const endpoint = { adapter: "adapter-a", endpointId: "ack-recipient" };
  const from = { adapter: "adapter-a", endpointId: "ack-sender" };
  const attach = capabilityFor(f, recipient, "attach");
  for (const sessionId of [S1,S2,S3]) bindSession(f.store, { participantId: recipient, sessionId, capability: attach }, clockAt(0));
  acquireOwnership(f.store, { participantId: recipient, sessionId: S1, capability: attach }, clockAt(0));
  const senderAttach = capabilityFor(f, sender, "attach");
  bindSession(f.store, { participantId: sender, sessionId: SENDER, capability: senderAttach }, clockAt(0));
  acquireOwnership(f.store, { participantId: sender, sessionId: SENDER, capability: senderAttach }, clockAt(0));
  for (const participantId of [recipient,sender]) joinExchange(f.store, { exchangeId, participantId, capability: capabilityFor(f,participantId,"join"), idempotencyKey: `join-${participantId}` }, clockAt(0));
  const sendCapability = capabilityFor(f,sender,"send",{sessionId:SENDER});
  let key=0;
  const send = (to=endpoint, payload=new Uint8Array([7,7,7,7])) => sendMessage(f.store, {
    participantId:sender,sessionId:SENDER,fencingToken:1,capability:sendCapability,
    message:{exchangeId,from,to,payload,idempotencyKey:`message-${++key}`},
  },clockAt(5));
  const sent=send();
  const capability=capabilityFor(f,recipient,"ack",{sessionId:S1});
  const input={participantId:recipient, sessionId:S1, fencingToken:1, capability, exchangeId,
    messageId:sent.message.messageId, payloadDigest:createHash("sha256").update(new Uint8Array([7,7,7,7])).digest("hex"),
    payloadLength:4, messageCreatedAuditSequence:sent.auditSequence};
  return { f,exchangeId,recipient,sender,endpoint,from,attach,send,sent,input };
}
export type AckWorld = ReturnType<typeof ackWorld>;
const SNAPSHOT_QUERIES = {
  attempt: "SELECT * FROM attempt ORDER BY rowid",
  audit_event: "SELECT * FROM audit_event ORDER BY rowid",
  current_claim: "SELECT * FROM current_claim ORDER BY rowid",
  delivery_ack_receipt: "SELECT * FROM delivery_ack_receipt ORDER BY rowid",
  delivery_cursor: "SELECT * FROM delivery_cursor ORDER BY rowid",
  disposition: "SELECT * FROM disposition ORDER BY rowid",
  evidence_application: "SELECT * FROM evidence_application ORDER BY rowid",
  evidence_envelope: "SELECT * FROM evidence_envelope ORDER BY rowid",
  exchange: "SELECT * FROM exchange ORDER BY rowid",
  exchange_membership: "SELECT * FROM exchange_membership ORDER BY rowid",
  fencing_high_water: "SELECT * FROM fencing_high_water ORDER BY rowid",
  host_trust_root: "SELECT * FROM host_trust_root ORDER BY rowid",
  idempotency_record: "SELECT * FROM idempotency_record ORDER BY rowid",
  message: "SELECT * FROM message ORDER BY rowid",
  participant: "SELECT * FROM participant ORDER BY rowid",
  participant_capability: "SELECT * FROM participant_capability ORDER BY rowid",
  participant_fencing_high_water: "SELECT * FROM participant_fencing_high_water ORDER BY rowid",
  participant_ownership: "SELECT * FROM participant_ownership ORDER BY rowid",
  participant_session: "SELECT * FROM participant_session ORDER BY rowid",
  reconciliation: "SELECT * FROM reconciliation ORDER BY rowid",
  restore_hold: "SELECT * FROM restore_hold ORDER BY rowid",
  result: "SELECT * FROM result ORDER BY rowid",
  schema_migrations: "SELECT * FROM schema_migrations ORDER BY rowid",
  store_metadata: "SELECT * FROM store_metadata ORDER BY rowid",
};
/** Full-row snapshot via independent observer after writer quiescence. */
export function snapshot(f: Fixture, exclude: readonly string[] = []): string {
  const db=reader(f);
  try {
    expectKnownTables(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r=>String(r.name)));
    return JSON.stringify(Object.fromEntries(Object.entries(SNAPSHOT_QUERIES).filter(([name])=>!exclude.includes(name)).map(([name,sql])=>[name,db.prepare(sql).all()])));
  } finally { db.close(); }
}
function expectKnownTables(names: string[]) {
  if (JSON.stringify(names) !== JSON.stringify(Object.keys(SNAPSHOT_QUERIES).sort())) throw new Error("unexpected snapshot table inventory");
}
export function changes(f: Fixture) { return f.store.database.prepare("SELECT total_changes() AS n").get()!.n; }
