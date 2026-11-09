import json
from pathlib import Path
import unittest
from unittest import mock

import check_only
import ownership_feedback
import receipt_target
import test_check_only as fixture
from test_ownership_guard import REQUEST, IN, SCOPE


class MetadataReceiptTests(unittest.TestCase):
    def setUp(self):
        self.f = fixture.CheckOnlyTests()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.raw_session = Path(self.f.cfg['nativeSessionFile'])

    def append_custom(self, kind, data):
        # This is an isolated fixture, never the live native transcript.
        with self.raw_session.open('a') as stream:
            stream.write(json.dumps({'type': 'custom', 'customType': kind, 'data': data}) + '\n')

    def insert_request(self, audit=200):
        meta = {'messageId': REQUEST, 'exchangeId': SCOPE['exchangeId'], 'from': SCOPE['to'],
                'to': SCOPE['from'], 'payloadDigest': '1' * 64, 'payloadLength': 1,
                'createdAt': '2026-11-08T06:00:00Z', 'auditSequence': audit}
        self.f.f.db.execute('INSERT INTO message VALUES(?,?,?,?,?,?,?,?)',
                            (REQUEST, SCOPE['exchangeId'], json.dumps({'adapter':'chatgpt','endpointId':SCOPE['to']}),
                             json.dumps({'adapter':'pi','endpointId':SCOPE['from']}), meta['payloadDigest'],
                             meta['payloadLength'], meta['createdAt'], 'synthetic-incoming'))
        self.f.f.db.execute('INSERT INTO audit_event VALUES(?,?,?,?)', (audit, SCOPE['exchangeId'], 'message_created', REQUEST))
        self.f.f.db.commit()
        self.append_custom('ce-inbound-wake', {'messageId': REQUEST, 'runtimeSessionId': self.f.f.sid,
                           'endpointId': SCOPE['from'], 'auditSequence': audit, 'admittedAt': 1, 'metadata': meta})
        self.append_custom('ce-inbound-receive', {'messageId': REQUEST, 'status': 'RETURNED'})

    def prepare_real_claim(self):
        with mock.patch.object(check_only.auto_wake, 'resolve_runtime', return_value=self.f.runtime):
            return check_only.prepare(REQUEST, 'synthetic-notify', self.f.cfg)

    def test_valid_minimal_explicit_only_uses_actual_native_and_sqlite_receipt(self):
        self.insert_request()
        self.assertEqual(self.f.cfg['conversationGuard'], {'mode': 'explicit-only'})
        self.assertEqual(self.prepare_real_claim()['status'], 'PREPARED')

    def test_stricter_intake_and_global_watermarks_cannot_be_relaxed(self):
        self.insert_request()
        for guard, global_cutoff in [({'mode': 'explicit-only', 'targetSelection': 'desktop-at-intake', 'captureAfterAuditSequence': 200}, 100),
                                     ({'mode': 'explicit-only', 'targetSelection': 'desktop-at-intake', 'captureAfterAuditSequence': 150}, 200)]:
            with self.subTest(guard=guard):
                self.f.cfg['conversationGuard'] = guard
                self.f.cfg['afterAuditSequence'] = global_cutoff
                self.f.f.private(self.f.f.config_path, self.f.cfg)
                with self.assertRaisesRegex(ValueError, 'BEFORE_CAPTURE_CUTOFF'):
                    self.prepare_real_claim()

    def test_only_exact_native_metadata_records_are_parsed(self):
        with self.raw_session.open('a') as stream:
            stream.write(json.dumps({'type': 'message', 'business': 'PRIVATE_BODY_SENTINEL'}) + '\n')
        self.append_custom('ce-inbound-wake', {'messageId': 'msg_' + 'Z' * 26, 'other': 'OLD_TASK_SENTINEL'})
        self.insert_request()
        original = receipt_target.object_json
        seen = []
        def observe(raw):
            seen.append(raw)
            return original(raw)
        with mock.patch.object(receipt_target, 'object_json', side_effect=observe):
            self.assertEqual(self.prepare_real_claim()['status'], 'PREPARED')
        self.assertTrue(seen)
        self.assertFalse(any('PRIVATE_BODY_SENTINEL' in str(raw) or 'OLD_TASK_SENTINEL' in str(raw) for raw in seen))

    def test_other_record_referencing_target_mid_in_another_field_is_not_parsed(self):
        # A different feedback record may cite the target MID as requestMessageId.
        # Only the record's own messageId field selects the target.
        self.append_custom('ce-inbound-feedback', {'messageId': 'msg_' + 'Y' * 26,
                           'association': {'kind': 'FEEDBACK', 'requestMessageId': REQUEST},
                           'body': 'OTHER_RECORD_SENTINEL'})
        self.insert_request()
        original = receipt_target.object_json
        seen = []
        def observe(raw):
            seen.append(raw)
            return original(raw)
        with mock.patch.object(receipt_target, 'object_json', side_effect=observe):
            self.assertEqual(self.prepare_real_claim()['status'], 'PREPARED')
        self.assertFalse(any('OTHER_RECORD_SENTINEL' in str(raw) for raw in seen))

    def test_noncontrol_and_other_nested_mid_never_enter_json_decoder(self):
        rows = [
            {'type': 'message', 'message': {'role': 'toolResult', 'details': {'task':
                 {'messageId': REQUEST, 'text': 'BUSINESS_BODY_SENTINEL'}}}},
            {'type': 'custom', 'customType': 'ce-inbound-feedback', 'data':
                 {'messageId': 'msg_' + 'Y' * 26, 'metadata': {'messageId': REQUEST}}},
        ]
        for row in rows:
            with self.subTest(kind=row['type']), mock.patch.object(
                    json.JSONDecoder, 'raw_decode', side_effect=AssertionError('NON_TARGET_DECODED')):
                self.assertEqual(receipt_target.target_records(json.dumps(row).encode(), REQUEST), [])

    def test_invalid_utf8_in_an_unrelated_line_does_not_decode_or_block_target(self):
        with self.raw_session.open('ab') as stream:
            stream.write(b'{"type":"message","text":"\xe4\xb8\n')
        self.insert_request()
        self.assertEqual(self.prepare_real_claim()['status'], 'PREPARED')

    def test_torn_line_is_not_reconstructed_into_native_proof(self):
        with self.raw_session.open('ab') as stream:
            stream.write(b'{"type":"custom","customType":"ce-inbound-wake","data":{"messageId":"msg_OTHER')
        self.insert_request()
        with self.assertRaisesRegex(ValueError, 'INBOUND_CLAIM_REQUIRED'):
            self.prepare_real_claim()

    def test_truncated_other_record_never_blocks_the_valid_target(self):
        with self.raw_session.open('a') as stream:
            stream.write('{"type":"custom","customType":"ce-inbound-wake","data":{"messageId":"msg_' + 'Y' * 26 + '\n')
        self.insert_request()
        self.assertEqual(self.prepare_real_claim()['status'], 'PREPARED')


    def test_forged_control_object_inside_business_payload_is_not_a_receipt(self):
        forged = {'type': 'custom', 'customType': 'ce-inbound-wake',
                  'data': {'messageId': REQUEST, 'runtimeSessionId': self.f.f.sid,
                          'endpointId': SCOPE['from'], 'auditSequence': 200, 'admittedAt': 1,
                          'metadata': {'messageId': REQUEST, 'exchangeId': SCOPE['exchangeId'],
                                      'from': SCOPE['to'], 'to': SCOPE['from'],
                                      'payloadDigest': '1' * 64, 'payloadLength': 1,
                                      'createdAt': '2026-11-08T06:00:00Z', 'auditSequence': 200}}}
        self.append_custom('ce-inbound-request', {'body': json.dumps(forged)})
        self.insert_request()
        # The genuine target record still resolves, and the forged text never
        # becomes a claim of its own.
        self.assertEqual(self.prepare_real_claim()['status'], 'PREPARED')
        line = json.dumps({'type': 'custom', 'customType': 'ce-inbound-request',
                          'data': {'body': json.dumps(forged)}}).encode()
        records = receipt_target.target_records(line, REQUEST)
        self.assertEqual(records, [])
    def test_feedback_uses_same_metadata_only_receipt_with_minimal_config(self):
        # Reuse the fixture's real committed feedback metadata and native control receipt.
        f = self.f.f
        import hashlib
        projection = f.store.associate(REQUEST, {'messageId': fixture.OUT, 'disposition': 'CREATED', **SCOPE})
        f.body['probeId'] = projection['probeId']
        text = json.dumps(f.body, sort_keys=True)
        f.metadata.update(payloadDigest=hashlib.sha256(text.encode()).hexdigest(), payloadLength=len(text.encode()))
        f.insert('ce-owner-feedback:' + projection['probeId'] + ':WRONG_CONVERSATION')
        association = f.classify()
        data = {'messageId': IN, 'runtimeSessionId': f.sid, 'endpointId': SCOPE['from'],
                'auditSequence': 201, 'admittedAt': 1, 'metadata': f.metadata, 'association': association}
        self.append_custom('ce-inbound-feedback', data)
        self.append_custom('ce-inbound-receive', {'messageId': IN, 'status': 'RETURNED'})
        context = f.context()
        with mock.patch.object(ownership_feedback.auto_wake, 'resolve_runtime', return_value=self.f.runtime):
            result = ownership_feedback.consume(context, {'metadata': f.metadata, 'association': association,
                                                          'text': json.dumps(f.body, sort_keys=True)})
        self.assertEqual(result['kind'], 'TERMINAL')
        self.assertTrue(result['suppressOrdinaryReply'])
        # A later valid mode change must not rescan business records or turn
        # the same committed CHECK_ONLY into a legacy notification/retry.
        f.cfg['conversationGuard'] = {'mode': 'ownership-check', 'registryDirectory': str(f.store.root),
                                      'captureAfterAuditSequence': 100}
        f.private(f.config_path, f.cfg)
        f.db.execute('INSERT INTO message VALUES(?,?,?,?,?,?,?,?)',
                     (fixture.OUT, SCOPE['exchangeId'], json.dumps({'adapter': 'pi', 'endpointId': SCOPE['from']}),
                      json.dumps({'adapter': 'chatgpt', 'endpointId': SCOPE['to']}), '0' * 64, 1,
                      '2026-11-08T06:00:00Z', 'ce-check-only:' + 'f' * 64))
        f.db.execute('INSERT INTO audit_event VALUES(?,?,?,?)', (200, SCOPE['exchangeId'], 'message_created', fixture.OUT))
        f.db.commit()
        with self.raw_session.open('a') as stream:
            stream.write(json.dumps({'type': 'message', 'business': 'PRIVATE_CONTROL_SENTINEL'}) + '\n')
        context = f.context()
        original = receipt_target.object_json
        seen = []
        def inspect(raw):
            seen.append(raw)
            return original(raw)
        with mock.patch.object(ownership_feedback.auto_wake, 'resolve_runtime', return_value=self.f.runtime), \
             mock.patch.object(receipt_target, 'object_json', side_effect=inspect), \
             mock.patch.object(receipt_target, 'inbound_claim', wraps=receipt_target.inbound_claim) as native, \
             mock.patch('subprocess.run', side_effect=AssertionError('REAL_PROCESS_FORBIDDEN')):
            result = ownership_feedback.consume(context, {'metadata': f.metadata, 'association': association, 'text': text})
        self.assertEqual(result['kind'], 'TERMINAL')
        self.assertEqual(native.call_count, 1)
        self.assertTrue(native.call_args.kwargs['metadata_only'])
        self.assertFalse(any('PRIVATE_CONTROL_SENTINEL' in str(raw) for raw in seen))


if __name__ == '__main__':
    unittest.main()
