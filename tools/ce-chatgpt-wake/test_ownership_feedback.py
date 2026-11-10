import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

import ownership_guard as guard
import ownership_loop
import ownership_feedback as feedback
from test_ownership_guard import REQUEST, OUT, IN, SCOPE
from test_wake import Desktop


class FeedbackBridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name).resolve()
        self.store = guard.Store(root / 'registry', SCOPE)
        self.store.register(REQUEST, 'synthetic-project', 'synthetic-project', confirmation='EXPLICIT_USER')
        self.projection = self.store.associate(REQUEST, {'messageId': OUT, 'disposition': 'CREATED', **SCOPE})
        owner = root / 'hook'
        owner.mkdir(mode=0o700)
        self.sid = '00000000-0000-4000-8000-000000000000'
        session = root / 'session.jsonl'
        self.private(session, {'type': 'session', 'id': self.sid})
        self.cfg = {key: str(root / key) for key in (
            'stateDir', 'profilePath', 'packageRoot', 'python', 'node', 'agentDesktop', 'terminalNotifier')}
        self.cfg.update(ownerDirectory=str(owner), nativeSessionFile=str(session), conversationMarker='synthetic',
                        maxWaitSeconds=1, notificationTimeoutSeconds=1, afterAuditSequence=100,
                        conversationGuard={'mode': 'explicit-only'})
        self.config_path = owner / 'auto-wake.json'
        self.private(self.config_path, self.cfg)
        self.sidecar = root / 'native.json.task-ownership.json'
        self.private(self.sidecar, {'schemaVersion': 1, 'registryDirectory': str(self.store.root),
                                    'observerConfig': str(self.config_path)})
        self.db_path = root / 'ce.sqlite'
        self.db = sqlite3.connect(self.db_path)
        self.addCleanup(self.db.close)
        self.db.executescript('''CREATE TABLE message(message_id TEXT PRIMARY KEY,exchange_id TEXT,
from_endpoint_json TEXT,to_endpoint_json TEXT,payload_digest TEXT,payload_length INTEGER,created_at TEXT,idempotency_key TEXT);
CREATE TABLE audit_event(sequence INTEGER PRIMARY KEY,exchange_id TEXT,kind TEXT,subject_id TEXT);''')
        self.db_path.chmod(0o600)
        self.body = {k: self.projection[k] for k in ('messageId', 'requestMessageId', 'probeId')}
        self.body.update(protocol='ce.task-owner-feedback.v1', outcome='WRONG_CONVERSATION')
        text = json.dumps(self.body, sort_keys=True)
        self.metadata = {'messageId': IN, 'exchangeId': SCOPE['exchangeId'], 'from': SCOPE['to'], 'to': SCOPE['from'],
                         'payloadDigest': hashlib.sha256(text.encode()).hexdigest(), 'payloadLength': len(text.encode()),
                         'createdAt': '2026-11-08T06:00:00Z', 'auditSequence': 201}
        self.runtime = {'runtimeSessionId': self.sid, 'hookSenderEndpointId': SCOPE['from'],
                        'hookRecipientEndpointId': SCOPE['to'], 'hookExchangeId': SCOPE['exchangeId'],
                        'databasePath': str(self.db_path)}
        self.insert('ce-owner-feedback:' + self.projection['probeId'] + ':WRONG_CONVERSATION')

    def private(self, path, value):
        path.write_text(json.dumps(value) + '\n')
        path.chmod(0o600)

    def insert(self, key):
        self.db.execute('INSERT OR REPLACE INTO message VALUES(?,?,?,?,?,?,?,?)',
                        (IN, self.metadata['exchangeId'], json.dumps({'adapter': 'chatgpt', 'endpointId': SCOPE['to']}),
                         json.dumps({'adapter': 'pi', 'endpointId': SCOPE['from']}), self.metadata['payloadDigest'],
                         self.metadata['payloadLength'], self.metadata['createdAt'], key))
        self.db.execute('INSERT OR REPLACE INTO audit_event VALUES(?,?,?,?)',
                        (201, SCOPE['exchangeId'], 'message_created', IN))
        self.db.commit()

    def context(self):
        return feedback.load_context(self.sidecar, self.db_path, self.sid, SCOPE['from'])

    def classify(self):
        return feedback.classify(self.context(), self.metadata)

    def consume(self, text=None, association=None):
        text = json.dumps(self.body, sort_keys=True) if text is None else text
        self.metadata.update(payloadDigest=hashlib.sha256(text.encode()).hexdigest(), payloadLength=len(text.encode()))
        key = self.db.execute('SELECT idempotency_key FROM message WHERE message_id=?', (IN,)).fetchone()[0]
        self.insert(key)
        context = self.context()
        expected = self.classify() if association is None else association
        claim = {'metadata': self.metadata, 'auditSequence': 201}
        with mock.patch.object(feedback.auto_wake, 'resolve_runtime', return_value=self.runtime), \
             mock.patch.object(feedback.receipt_target, 'inbound_claim', return_value=claim) as native:
            result = feedback.consume(context, {'metadata': self.metadata, 'association': expected,
                                                'text': text})
        native.assert_called_once_with(context['config'], self.runtime, IN, require_read=True, metadata_only=True)
        return result

    def test_confirmed_project_label_can_also_be_registered_task_owner(self):
        self.assertEqual(self.projection['ownerStatus'], 'REGISTERED')
        self.assertEqual(self.projection['projectLabel'], self.projection['taskOwner'])

    def test_committed_key_and_local_projection_redirect_exact_control(self):
        result = self.classify()
        self.assertEqual(result, {'kind': 'FEEDBACK', 'messageId': IN, 'requestMessageId': REQUEST,
                                 'outgoingMessageId': OUT, 'probeId': self.projection['probeId'],
                                 'outcomeHint': 'WRONG_CONVERSATION'})
        self.assertEqual(self.store.state(OUT)['feedback'], None)
        self.assertEqual(list((self.store.root / 'terminal').iterdir()), [])

    def test_ordinary_key_cannot_become_control_from_payload_self_claim(self):
        self.insert('ordinary-business-key')
        self.assertEqual(self.classify(), {'kind': 'NONE'})

    def test_unknown_or_malformed_reserved_probe_never_falls_through(self):
        for key in ('ce-owner-feedback:malformed', 'ce-owner-feedback:00000000-0000-4000-8000-000000000000:MATCH'):
            with self.subTest(key=key):
                self.insert(key)
                self.assertEqual(self.classify()['kind'], 'BLOCKED')

    def test_source_digest_audit_and_extra_fields_fail_before_control(self):
        for field, value in [('from', 'chatgpt/other'), ('to', 'pi/other'), ('exchangeId', 'ho_' + 'E' * 26),
                             ('payloadDigest', '0' * 64), ('auditSequence', 202), ('payload', 'private')]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                feedback.classify(self.context(), {**self.metadata, field: value})

    def test_conflicting_owner_registration_preserves_terminal_control_without_payload_authority(self):
        self.store.register(REQUEST, 'other', 'other', confirmation='EXPLICIT_USER')
        self.assertEqual(self.classify()['kind'], 'FEEDBACK')
        self.assertEqual(self.consume()['kind'], 'TERMINAL')

    def test_consume_records_terminal_without_ui_under_explicit_only(self):
        self.store.attempt(OUT, {'windowId': 'w-1', 'maxWaitSeconds': 1}, Desktop())
        with mock.patch.object(ownership_loop, 'receive_feedback', side_effect=AssertionError('UI action path')):
            result = self.consume()
        self.assertEqual(result['kind'], 'TERMINAL')
        self.assertEqual(result['outcome'], 'WRONG_CONVERSATION')
        self.assertEqual(result['status'], 'RECORDED')
        self.assertTrue(result['suppressOrdinaryReply'])
        self.assertFalse(self.store.state(OUT)['notificationEligible'])
        self.assertTrue((self.store.root / 'terminal' / (IN + '.json')).exists())
        self.assertNotIn('text', result)

    def test_native_receive_refusal_prevents_consume(self):
        context = self.context()
        with mock.patch.object(feedback.auto_wake, 'resolve_runtime', return_value=self.runtime), \
             mock.patch.object(feedback.receipt_target, 'inbound_claim', side_effect=ValueError('REQUEST_NOT_RECEIVED')):
            with self.assertRaisesRegex(ValueError, 'REQUEST_NOT_RECEIVED'):
                feedback.consume(context, {'metadata': self.metadata, 'association': self.classify(),
                                            'text': json.dumps(self.body)})
        self.assertFalse((self.store.root / 'terminal' / (IN + '.json')).exists())

    def test_changed_association_or_database_is_refused(self):
        association = {**self.classify(), 'outgoingMessageId': REQUEST}
        with self.assertRaises(ValueError):
            self.consume(association=association)
        self.runtime['databasePath'] = str(self.db_path.with_name('foreign.sqlite'))
        with self.assertRaises(ValueError):
            self.consume()

    def test_unknown_and_invalid_body_are_terminal_unverified_without_text(self):
        for text in ('private invalid text', json.dumps({**self.body, 'probeId': 'wrong'}),
                     json.dumps({**self.body, 'outcome': 'MATCH'}), 'x' * 2049):
            with self.subTest(text=text[:25]):
                result = self.consume(text=text)
                self.assertEqual(result['outcome'], 'UNVERIFIED')
                self.assertEqual(result['status'], 'UNVERIFIED')
                self.assertNotIn('text', result)
                self.assertFalse(self.store.state(OUT)['notificationEligible'])
                self.assertTrue((self.store.root / 'terminal' / (IN + '.json')).exists())

    def test_unknown_hint_is_terminal_unverified_and_never_notifies(self):
        self.insert('ce-owner-feedback:' + self.projection['probeId'] + ':UNKNOWN')
        self.body['outcome'] = 'UNKNOWN'
        result = self.consume()
        self.assertEqual(result['status'], 'UNVERIFIED')
        self.assertFalse(self.store.state(OUT)['notificationEligible'])

    def test_pending_terminal_mid_cannot_prepare_ordinary_reply(self):
        self.consume(text='invalid control body')
        cfg = {**self.cfg, 'conversationGuard': {'mode': 'ownership-check', 'registryDirectory': str(self.store.root),
                                                 'captureAfterAuditSequence': 100}}
        with mock.patch.object(ownership_loop.receipt_target, 'inbound_claim', return_value={'auditSequence': 201}), \
             mock.patch.object(ownership_loop, 'key_metadata', return_value=None):
            with self.assertRaisesRegex(ValueError, 'CONTROL_FEEDBACK_IS_TERMINAL'):
                ownership_loop.prepare(IN, 'must-not-reply', cfg, self.runtime)

    def test_private_config_and_session_must_match(self):
        self.sidecar.chmod(0o644)
        with self.assertRaises((ValueError, OSError)):
            self.context()
        self.sidecar.chmod(0o600)
        with self.assertRaises(ValueError):
            feedback.load_context(self.sidecar, self.db_path, 'foreign-session', SCOPE['from'])


    def test_native_control_claim_proves_returned_without_business_wake(self):
        config = {**self.cfg, 'conversationGuard': {'mode': 'explicit-only', 'targetSelection': 'desktop-at-intake',
                                                   'captureAfterAuditSequence': 100}}
        claim = {'runtimeSessionId': self.sid, 'endpointId': SCOPE['from'], 'metadata': self.metadata,
                 'messageId': IN, 'auditSequence': 201, 'admittedAt': 1000, 'association': self.classify()}
        entries = [{'type': 'session', 'id': self.sid},
                   {'type': 'custom', 'customType': 'ce-inbound-feedback', 'data': claim},
                   {'type': 'custom', 'customType': 'ce-inbound-receive',
                    'data': {'messageId': IN, 'status': 'RETURNED'}}]
        path = Path(config['nativeSessionFile'])
        path.write_text(''.join(json.dumps(x) + '\n' for x in entries))
        actual = feedback.receipt_target.inbound_claim(config, self.runtime, IN, require_read=True)
        self.assertEqual(actual['metadata'], self.metadata)

    def test_text_mismatch_is_terminal_unverified_even_with_native_receipt(self):
        context = self.context()
        with mock.patch.object(feedback.auto_wake, 'resolve_runtime', return_value=self.runtime), \
             mock.patch.object(feedback.receipt_target, 'inbound_claim', return_value={'metadata': self.metadata}):
            result = feedback.consume(context, {'metadata': self.metadata, 'association': self.classify(),
                                                'text': json.dumps({**self.body, 'outcome': 'MATCH'})})
        self.assertEqual(result['status'], 'UNVERIFIED')
        self.assertFalse(self.store.state(OUT)['notificationEligible'])


    def test_cli_classifies_metadata_with_sqlite_and_no_payload_table(self):
        import subprocess
        command = ['/opt/homebrew/bin/python3', '-B', str(Path(feedback.__file__)),
                   '--sidecar', str(self.sidecar), '--database-path', str(self.db_path),
                   '--runtime-session-id', self.sid, '--endpoint-id', SCOPE['from'], '--action', 'classify']
        result = subprocess.run(command, input=json.dumps(self.metadata), text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), self.classify())
        self.assertNotIn('payload', json.loads(result.stdout))

    def test_cli_malformed_input_does_not_echo_untrusted_body(self):
        import subprocess
        command = ['/opt/homebrew/bin/python3', '-B', str(Path(feedback.__file__)),
                   '--sidecar', str(self.sidecar), '--database-path', str(self.db_path),
                   '--runtime-session-id', self.sid, '--endpoint-id', SCOPE['from'], '--action', 'classify']
        result = subprocess.run(command, input='private-output-canary', text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.assertNotIn('private-output-canary', result.stderr)


    def test_unknown_body_shapes_are_terminal_instead_of_raising(self):
        for outcome in ([], {}, None, 1, True):
            with self.subTest(outcome=outcome):
                result = self.consume(text=json.dumps({**self.body, 'outcome': outcome}))
                self.assertEqual(result['status'], 'UNVERIFIED')
                self.assertFalse(self.store.state(OUT)['notificationEligible'])


if __name__ == '__main__':
    unittest.main()
