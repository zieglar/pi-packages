"""Isolated end-to-end check of the Hook CLI, detached worker and dispatch journal.

Everything runs against a private temporary owner directory with a synthetic CE
store and a stub runtime resolver. No real CE policy, no desktop command and no
terminal notification is ever used.
"""
import datetime
import importlib.util
import json
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

import test_hook

SOURCE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('auto_wake', SOURCE / 'auto_wake.py')
assert spec is not None and spec.loader is not None
auto = importlib.util.module_from_spec(spec)
spec.loader.exec_module(auto)


class HookIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.owner = Path(self.temp.name)
        self.tools = self.owner / 'tools/ce-chatgpt-wake'
        self.tools.mkdir(parents=True)
        for name in ('wake.py', 'auto_wake.py', 'notification.py', 'conversation_guard.py',
                     'check_only.py', 'check_only_desktop.py', 'ownership_loop.py', 'ownership_guard.py',
                     'ownership_feedback.py', 'receipt_target.py'):
            shutil.copy2(SOURCE / name, self.tools / name)
        bridge = self.owner / 'tools/ce-ovis-desktop'
        bridge.mkdir()
        for name in ('bridge.py', 'lifecycle.py'):
            shutil.copy2(SOURCE.parent / 'ce-ovis-desktop' / name, bridge / name)
        self.state = self.owner / 'state'
        self.state.mkdir(mode=0o700)
        self.event = test_hook.event()
        self.database = self.owner / 'store.sqlite'
        self.build_store()
        self.stub_resolver()

    def build_store(self):
        db = sqlite3.connect(self.database)
        db.executescript('''
CREATE TABLE message(message_id, exchange_id, from_endpoint_json, to_endpoint_json,
 payload_digest, payload_length, created_at, idempotency_key);
CREATE TABLE exchange(exchange_id, state);
CREATE TABLE audit_event(sequence, kind, subject_id, created_at, outcome, exchange_id);
CREATE TABLE participant(participant_id, endpoint_adapter, endpoint_id);
CREATE TABLE participant_ownership(participant_id, session_id, expires_at);
CREATE TABLE participant_session(participant_id, session_id, detached_at);
CREATE TABLE exchange_membership(exchange_id, participant_id);
''')
        e = self.event
        db.execute('INSERT INTO message VALUES(?,?,?,?,?,?,?,?)',
                   (e['messageId'], e['exchangeId'], json.dumps(e['sender']), json.dumps(e['recipient']),
                    e['payloadDigest'], e['payloadLength'], e['createdAt'], 'ordinary-fixture'))
        db.execute('INSERT INTO exchange VALUES(?,?)', (e['exchangeId'], 'OPEN'))
        db.execute('INSERT INTO audit_event VALUES(?,?,?,?,?,?)', (1, 'message_created', e['messageId'], e['createdAt'], None, e['exchangeId']))
        expiry = (datetime.datetime.now(datetime.UTC) + datetime.timedelta(hours=1)).isoformat()
        for participant, endpoint, session in (('p1', e['sender'], 'native-session'), ('p2', e['recipient'], 'chat-session')):
            db.execute('INSERT INTO participant VALUES(?,?,?)', (participant, endpoint['adapter'], endpoint['endpointId']))
            db.execute('INSERT INTO participant_ownership VALUES(?,?,?)', (participant, session, expiry))
            db.execute('INSERT INTO participant_session VALUES(?,?,NULL)', (participant, session))
            db.execute('INSERT INTO exchange_membership VALUES(?,?)', (e['exchangeId'], participant))
        db.commit()
        db.close()

    def stub_resolver(self):
        runtime = {'hookSenderAdapter': 'pi', 'hookSenderEndpointId': self.event['sender']['endpointId'],
                   'hookRecipientAdapter': 'chatgpt', 'hookRecipientEndpointId': self.event['recipient']['endpointId'],
                   'hookExchangeId': self.event['exchangeId'], 'stateDir': str(self.state),
                   'databasePath': str(self.database), 'ceSessionId': 'native-session', 'participantId': 'p1'}
        stub = self.tools / 'resolve-runtime.mjs'
        stub.write_text('console.log(' + json.dumps(json.dumps(runtime)) + ');\n')
        stub.chmod(0o600)

    def write_config(self, python=None):
        config = {'stateDir': str(self.state), 'profilePath': str(self.owner / 'tunnel.yaml'),
                  'packageRoot': str(self.owner / 'package'), 'nativeSessionFile': str(self.owner / 'native.jsonl'),
                  'python': python or sys.executable, 'node': shutil.which('node'),
                  'agentDesktop': str(self.owner / 'no-agent-desktop'),
                  'terminalNotifier': str(self.owner / 'no-terminal-notifier'),
                  'ownerDirectory': str(self.owner), 'conversationMarker': 'HANDOFF-CE-AUTO-WAKE-PRODUCTION-01',
                  'maxWaitSeconds': 1, 'notificationTimeoutSeconds': 1, 'afterAuditSequence': 0}
        (self.owner / 'auto-wake.json').write_text(json.dumps(config))
        (self.owner / 'auto-wake.json').chmod(0o600)
        (self.owner / 'config.json').write_text(json.dumps({'autoWakeConfig': str(self.owner / 'auto-wake.json')}))
        (self.owner / 'config.json').chmod(0o600)
        return config

    def run_hook(self):
        started = time.monotonic()
        result = subprocess.run([sys.executable, '-B', str(self.tools / 'wake.py'), '--config',
                                  str(self.owner / 'config.json'), '--hook'],
                                 input=test_hook.encode(self.event), capture_output=True, timeout=30)
        return result, time.monotonic() - started

    def wait_for_stage(self, deadline_seconds=20):
        path = auto.claim_path({'stateDir': str(self.state)}, self.event['messageId'])
        deadline = time.monotonic() + deadline_seconds
        while time.monotonic() < deadline:
            if path.exists():
                try:
                    saved = json.loads(path.read_text())
                except json.JSONDecodeError:
                    saved = {}
                if saved.get('stage') in ('UNKNOWN', 'OBSERVED', 'FALLBACK_FINISHED', 'SUPPRESSED'):
                    return saved
            time.sleep(.05)
        return None

    def test_config_defaults_explicit_and_rejects_invalid_guard_options(self):
        config = self.write_config()
        path = self.owner / 'auto-wake.json'
        self.assertEqual(auto.load_config(path)['conversationGuard'], {'mode': 'explicit-only'})
        config['conversationGuard'] = {'mode': 'title-match'}
        path.write_text(json.dumps(config))
        self.assertEqual(auto.load_config(path)['conversationGuard'], {'mode': 'title-match'})
        for value in (None, {}, {'mode': 'other'}, {'mode': 'title-match', 'sourceTitle': 'guessed'}):
            config['conversationGuard'] = value
            path.write_text(json.dumps(config))
            with self.subTest(value=value), self.assertRaises(ValueError):
                auto.load_config(path)

    def test_hook_returns_within_budget_and_worker_continues_after_the_hook_exits(self):
        self.write_config()
        result, elapsed = self.run_hook()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertLess(elapsed, 8)
        self.assertEqual(json.loads(result.stdout)['dispatch'], 'QUEUED')
        # The detached worker keeps running after the Hook process is gone.
        saved = self.wait_for_stage()
        self.assertIsNotNone(saved)
        self.assertEqual(saved['stage'], 'SUPPRESSED')
        self.assertEqual(saved['conversationGuard']['reason'], 'EXPLICIT_ONLY')
        self.assertFalse((self.state / self.event['messageId']).exists())

    def test_repeated_hook_run_never_spawns_a_second_worker(self):
        self.write_config()
        first, _ = self.run_hook()
        self.assertEqual(first.returncode, 0)
        second, _ = self.run_hook()
        self.assertEqual(second.returncode, 0)
        self.assertEqual(json.loads(first.stdout), json.loads(second.stdout))
        self.wait_for_stage()

    def test_failed_spawn_keeps_the_claim_and_records_an_unknown_dispatch(self):
        self.write_config(python=str(self.owner / 'missing-python'))
        result, _ = self.run_hook()
        self.assertEqual(result.returncode, 1)
        dispatch = auto.read_dispatch({'stateDir': str(self.state)}, self.event['messageId'])
        self.assertEqual(dispatch['dispatch'], 'UNKNOWN')
        # The claim survives, so the message is never replayed automatically.
        second, _ = self.run_hook()
        self.assertEqual(second.returncode, 1)
        self.assertEqual(auto.read_dispatch({'stateDir': str(self.state)}, self.event['messageId'])['dispatch'], 'UNKNOWN')


if __name__ == '__main__':
    unittest.main()
