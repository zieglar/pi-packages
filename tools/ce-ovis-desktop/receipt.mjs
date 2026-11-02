import {DatabaseSync} from 'node:sqlite';

// The CE tools expose no outbound receipt lookup. This gate reads only this run's
// isolated Store; it cannot send, ACK, acquire ownership or alter delivery state.
export function requirePriorReceipt(storeFile, messageId, recipient, nextMessageId) {
  const db=new DatabaseSync(storeFile,{readOnly:true});
  try {
    db.exec('PRAGMA query_only=ON');
    const receipt=db.prepare(`SELECT r.receipt_id, r.exchange_id, a.sequence AS receipt_sequence FROM delivery_ack_receipt r
      JOIN message sent ON sent.message_id=r.message_id AND sent.exchange_id=r.exchange_id
      JOIN participant p ON p.participant_id=r.recipient_participant_id
      JOIN audit_event a ON a.exchange_id=r.exchange_id AND a.kind='receipt_recorded' AND a.subject_id=r.receipt_id
      WHERE r.message_id=? AND p.endpoint_adapter='chatgpt' AND p.endpoint_id=?
      AND r.payload_digest=sent.payload_digest AND r.payload_length=sent.payload_length`).get(messageId,recipient);
    const next=db.prepare(`SELECT a.sequence AS next_sequence FROM message m
      JOIN audit_event a ON a.exchange_id=m.exchange_id AND a.kind='message_created' AND a.subject_id=m.message_id
      WHERE m.message_id=? AND m.exchange_id=?`).get(nextMessageId,receipt?.exchange_id ?? '');
    if(!receipt || !next || receipt.receipt_sequence >= next.next_sequence)throw new Error('PRIOR_RESULT_ACK_REQUIRED');
  } finally {db.close();}
}
