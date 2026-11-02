import test from 'node:test';
import assert from 'node:assert/strict';
import {validateReply} from './reply.mjs';
test('only actual CE reply with exact task nonce/message correlation accepted',()=>{
 const round={testId:'CE-WAKE-TEST-01-1',nonce:'nonce-1'};
 const reply={schemaVersion:1,testId:round.testId,nonce:round.nonce,inReplyTo:'msg_actual'};
 assert.deepEqual(validateReply(JSON.stringify(reply),round,'msg_actual'),reply);
 for(const change of [{nonce:'other'},{inReplyTo:'other'},{testId:'other'},{payload:'extra'}]) assert.throws(()=>validateReply(JSON.stringify({...reply,...change}),round,'msg_actual'),/REPLY_CORRELATION_MISMATCH/);
});
