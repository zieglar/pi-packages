export function validateReply(text,round,messageId){
  let reply;
  try{reply=JSON.parse(text);}catch{throw Error('INVALID_CE_REPLY');}
  if(!reply || Object.keys(reply).sort().join(',')!=='inReplyTo,nonce,schemaVersion,testId' || reply.schemaVersion!==1 || reply.testId!==round.testId || reply.inReplyTo!==messageId || reply.nonce!==round.nonce) throw Error('REPLY_CORRELATION_MISMATCH');
  return reply;
}
