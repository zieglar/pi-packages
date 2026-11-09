"""Real helper subprocesses and SQLite, with synthetic desktop/runtime executables only."""
import fcntl
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

import receipt_target
import test_receipt_target
import test_wake


class ReceiptCliTests(unittest.TestCase):
    def test_real_lock_contention_reports_a_bounded_specific_reason(self):
        folder = receipt_target.directory(self.config)
        fd = os.open(folder / '.capture.lock', os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            result = self.run_helper('--capture', self.event['messageId'])
        finally:
            os.close(fd)
        self.assertEqual(result['reason'], 'CAPTURE_LOCK_BUSY')
        self.assertFalse(self.calls.exists())

    def test_receipt_expiring_while_waiting_never_accesses_desktop(self):
        self.fixture.claim['admittedAt'] = int(time.time() * 1000) - 29000
        self.fixture.write_history()
        folder = receipt_target.directory(self.config)
        fd = os.open(folder / '.capture.lock', os.O_CREAT | os.O_RDWR, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)
        release = threading.Timer(1.5, lambda: fcntl.flock(fd, fcntl.LOCK_UN))
        release.start()
        try:
            result = self.run_helper('--capture', self.event['messageId'])
        finally:
            release.join(); os.close(fd)
        self.assertEqual(result['reason'], 'CAPTURE_TOO_LATE')
        self.assertFalse(self.calls.exists())

    def test_nonzero_desktop_with_success_json_never_captures(self):
        desktop = self.root / 'fake-desktop'
        desktop.write_text(desktop.read_text() + '\nraise SystemExit(1)\n')
        result = self.run_helper('--capture', self.event['messageId'])
        self.assertEqual(result['status'], 'UNAVAILABLE')
        self.assertEqual(result['reason'], 'DESKTOP_COMMAND_FAILED')

    def setUp(self):
        self.fixture = test_receipt_target.ReceiptTargetTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.root.chmod(0o700)
        self.owner = self.root / 'owner'
        self.tools = self.owner / 'tools/ce-chatgpt-wake'
        self.tools.mkdir(parents=True)
        for path in (self.owner, self.tools.parent, self.tools):
            path.chmod(0o700)
        for name in ('receipt_target.py', 'auto_wake.py', 'wake.py', 'conversation_guard.py', 'notification.py'):
            (self.tools / name).write_bytes(Path(receipt_target.__file__).with_name(name).read_bytes())
            (self.tools / name).chmod(0o600)
        bridge = self.owner / 'tools/ce-ovis-desktop'
        bridge.mkdir(mode=0o700)
        for name in ('bridge.py', 'lifecycle.py'):
            (bridge / name).write_bytes((Path(receipt_target.__file__).parent.parent / 'ce-ovis-desktop' / name).read_bytes())
            (bridge / name).chmod(0o600)
        self.runtime = self.fixture.runtime
        self.event = self.fixture.event
        self.calls = self.root / 'desktop-calls.jsonl'
        node = self.root / 'fake-node'
        desktop = self.root / 'fake-desktop'
        self.executable(node, 'print(' + repr(json.dumps(self.runtime)) + ')\n')
        program = ('import sys\nfrom pathlib import Path\n'
                   'with Path(' + repr(str(self.calls)) + ").open('a') as f: f.write(repr(sys.argv[1:]) + '\\n')\n"
                   "if 'list-windows' in sys.argv:\n    print(" + repr(json.dumps({'version': '2.5', 'ok': True, 'data': [
                       {'id': 'w-1', 'title': 'ChatGPT', 'pid': 5, 'process_instance': 'generation'}]})) + ')\n'
                   "elif 'snapshot' in sys.argv:\n    print(" + repr(json.dumps(test_wake.snapshot(title='Synthetic target'))) + ')\n'
                   "else:\n    raise SystemExit('unexpected mutating command')\n")
        self.executable(desktop, program)
        self.config = {'ownerDirectory': str(self.owner), 'stateDir': str(self.root / 'state'),
                       'profilePath': str(self.root / 'unused-profile'), 'packageRoot': str(self.root / 'unused-package'),
                       'nativeSessionFile': self.fixture.config['nativeSessionFile'], 'python': sys.executable,
                       'node': str(node), 'agentDesktop': str(desktop), 'terminalNotifier': str(desktop),
                       'conversationMarker': self.fixture.config['conversationMarker'], 'maxWaitSeconds': 1,
                       'notificationTimeoutSeconds': 1, 'afterAuditSequence': 0,
                       'conversationGuard': {**self.fixture.config['conversationGuard'], 'mode': 'explicit-only'}}
        self.write_json(self.owner / 'auto-wake.json', self.config)
        self.write_json(self.owner / 'config.json', {'autoWakeConfig': str(self.owner / 'auto-wake.json')})

    def write_json(self, path, value):
        path.write_text(json.dumps(value))
        path.chmod(0o600)

    def executable(self, path, body):
        path.write_text('#!' + sys.executable + '\n' + body)
        path.chmod(0o700)

    def run_helper(self, *action, success=True):
        args = [sys.executable, '-B', str(self.tools / 'receipt_target.py'),
                '--config', str(self.owner / 'config.json'), '--session-id', self.runtime['runtimeSessionId'],
                '--endpoint-id', self.runtime['hookSenderEndpointId'], *action]
        env = {key: value for key, value in os.environ.items() if key in ('HOME', 'PATH', 'LANG')}
        result = subprocess.run(args, text=True, capture_output=True, timeout=10, env=env)
        self.assertEqual(result.returncode, 0 if success else 1, result.stderr)
        self.assertEqual(result.stderr, '')
        return json.loads(result.stdout)

    def test_real_process_observes_missing_marker_and_prepares_local_metadata_only(self):
        desktop = self.root / 'fake-desktop'
        desktop.write_text(desktop.read_text().replace('HANDOFF-CE-CHATGPT-WAKE-01', 'ordinary text'))
        result = self.run_helper('--capture', self.event['messageId'])
        self.assertEqual(result['status'], 'CAPTURED')
        self.assertEqual(result['reason'], 'OBSERVED_TARGET_MARKER_MISSING')
        saved = receipt_target.auto_wake.read_private(receipt_target.request_path(self.config, self.event['messageId']))
        self.assertEqual(saved['markerObservation'], 'MISSING')
        self.assertEqual(saved['version'], 2)
        prepared = self.run_helper('--prepare-reply', self.event['messageId'], '--task-id', 'observation-only-task')
        self.assertEqual(prepared['status'], 'PREPARED')
        calls = self.calls.read_text()
        self.assertNotIn('fill', calls)
        self.assertNotIn('click', calls)

    def test_real_process_captures_then_prepares_exact_reply(self):
        captured = self.run_helper('--capture', self.event['messageId'])
        self.assertEqual(captured, {'messageId': self.event['messageId'], 'status': 'CAPTURED', 'reason': 'OBSERVED_TARGET'})
        prepared = self.run_helper('--prepare-reply', self.event['messageId'], '--task-id', 'synthetic-task')
        self.assertEqual(prepared['status'], 'PREPARED')
        key = prepared['idempotencyKey']
        self.assertRegex(key, r'^ce-desktop-[0-9a-f]{64}$')
        outgoing = dict(self.event, messageId='msg_' + '4' * 26, eventKey=self.event['exchangeId'] + '/2')
        self.fixture.db.execute('INSERT INTO message VALUES(?,?,?,?,?,?,?,?)',
                                (outgoing['messageId'], outgoing['exchangeId'], json.dumps(outgoing['sender']),
                                 json.dumps(outgoing['recipient']), outgoing['payloadDigest'], outgoing['payloadLength'],
                                 outgoing['createdAt'], key))
        self.fixture.db.execute('INSERT INTO audit_event VALUES(?,?,?,?,?,?)',
                                (2, 'message_created', outgoing['messageId'], outgoing['createdAt'], None, outgoing['exchangeId']))
        self.fixture.db.commit()
        target = receipt_target.lookup_reply(outgoing, self.config, self.runtime)
        self.assertEqual(target['title'], 'Synthetic target')
        self.assertEqual(target['requestMessageId'], self.event['messageId'])
        calls = self.calls.read_text()
        self.assertIn('snapshot', calls)
        self.assertNotIn('fill', calls)
        self.assertNotIn('click', calls)

    def test_closed_outer_entry_refuses_before_any_desktop_command(self):
        self.write_json(self.owner / 'config.json', {})
        result = self.run_helper('--capture', self.event['messageId'], success=False)
        self.assertEqual(result['status'], 'UNAVAILABLE')
        self.assertFalse(self.calls.exists())
        self.assertFalse((Path(self.config['stateDir']) / 'conversation-targets').exists())


if __name__ == '__main__':
    unittest.main()
