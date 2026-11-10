"""Exercise cutover files/locks in private fixtures; runtime/process probes are substituted."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

auto_spec = importlib.util.spec_from_file_location('cutover_auto', Path(__file__).with_name('auto_wake.py'))
assert auto_spec and auto_spec.loader
auto_wake = importlib.util.module_from_spec(auto_spec)
auto_spec.loader.exec_module(auto_wake)

spec = importlib.util.spec_from_file_location('activate_explicit_only', Path(__file__).with_name('activate_explicit_only.py'))
assert spec and spec.loader
install = importlib.util.module_from_spec(spec)
spec.loader.exec_module(install)


class ExplicitCutoverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'live'
        self.root.mkdir(mode=0o700)
        (self.root / 'state').mkdir(mode=0o700)
        self.source = self.base / 'source'
        self.source.mkdir(mode=0o700)
        self.backup = self.base / 'backup'
        for name in install.BASELINE_FILES:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            target.write_text('old ' + name)
            target.chmod(0o600)
        self.config = {'stateDir': str(self.root / 'state'), 'profilePath': str(self.base / 'profile'),
                       'packageRoot': str(self.base / 'package'), 'nativeSessionFile': str(self.base / 'native'),
                       'python': '/usr/bin/python3', 'node': '/usr/bin/node', 'agentDesktop': '/unused/desktop',
                       'terminalNotifier': '/unused/notifier', 'ownerDirectory': str(self.root),
                       'conversationMarker': 'operator-selected-marker', 'maxWaitSeconds': 60,
                       'notificationTimeoutSeconds': 120, 'afterAuditSequence': 145}
        self.outer = {'autoWakeConfig': str(self.root / 'auto-wake.json')}
        (self.root / 'config.json').write_text(json.dumps(self.outer))
        (self.root / 'auto-wake.json').write_text(json.dumps(self.config))
        for name in install.SOURCE_FILES:
            target = self.source / name
            target.write_bytes(Path(__file__).with_name(name).read_bytes())
            target.chmod(0o600)
        self.baseline = {'files': {n: install.sha(self.root / n) for n in install.BASELINE_FILES},
                         'source': {n: install.sha(self.source / n) for n in install.SOURCE_FILES}}
        self.probe = lambda _: {'runtimeSessionId': 'operator-selected-runtime', 'policyDigest': 'a' * 64}

    def apply(self, **kwargs):
        return install.cutover(self.root, self.source, self.baseline, self.backup,
                               owner_probe=self.probe, process_probe=lambda _: [], **kwargs)

    def test_exact_backup_preserves_boundary_and_only_installs_reviewed_guard(self):
        result = self.apply()
        self.assertEqual(json.loads((self.root / 'config.json').read_text()), self.outer)
        config = auto_wake.load_config(self.root / 'auto-wake.json')
        self.assertEqual(config['conversationGuard'], {'mode': 'explicit-only'})
        self.assertEqual(config['afterAuditSequence'], 145)
        for name, digest in self.baseline['files'].items():
            self.assertEqual(install.sha(self.backup / 'before' / name), digest)
        self.assertEqual(result['mode'], 'explicit-only')
        for name in install.SOURCE_FILES:
            self.assertEqual(install.sha(self.root / 'tools/ce-chatgpt-wake' / name), self.baseline['source'][name])

    def test_baseline_or_source_drift_refuses_before_any_entry_change(self):
        (self.root / 'tools/ce-chatgpt-wake/auto_wake.py').write_text('drift')
        with self.assertRaisesRegex(ValueError, 'BASELINE_CHANGED'):
            self.apply()
        self.assertEqual(json.loads((self.root / 'config.json').read_text()), self.outer)
        self.assertFalse(self.backup.exists())

    def test_pending_or_unknown_claim_refuses_without_closing_entry(self):
        path = self.root / 'state/msg_claim.json'
        for stage in ('ADMITTED', 'AUTO_MAY_HAVE_OCCURRED', 'UNKNOWN'):
            path.write_text(json.dumps({'event': {}, 'stage': stage}))
            path.chmod(0o600)
            with self.subTest(stage=stage), self.assertRaises(ValueError):
                self.apply()
            self.assertEqual(json.loads((self.root / 'config.json').read_text()), self.outer)

    def test_active_process_or_held_lock_refuses_without_entry_change(self):
        with self.assertRaisesRegex(ValueError, 'ACTIVE_WAKE'):
            install.cutover(self.root, self.source, self.baseline, self.backup,
                            owner_probe=self.probe, process_probe=lambda _: [{'pid': 10}])
        with auto_wake.locked(self.root / 'state/.desktop.lock'), self.assertRaises(BlockingIOError):
            self.apply()
        self.assertEqual(json.loads((self.root / 'config.json').read_text()), self.outer)

    def test_failure_after_gate_closure_keeps_entry_closed(self):
        real = install.atomic_write
        def fail_guard(path, content):
            if path.name == 'conversation_guard.py':
                self.assertEqual(json.loads((self.root / 'config.json').read_text()), {})
                raise OSError('fixture failure')
            real(path, content)
        with mock.patch.object(install, 'atomic_write', side_effect=fail_guard), self.assertRaises(OSError):
            self.apply()
        self.assertEqual(json.loads((self.root / 'config.json').read_text()), {})
        self.assertTrue((self.backup / 'before/config.json').exists())

    def test_safe_rollback_closes_entry_without_restoring_automatic_code(self):
        result = self.apply()
        before = (self.root / 'tools/ce-chatgpt-wake/auto_wake.py').read_bytes()
        install.close_entry(self.root, result, process_probe=lambda _: [])
        self.assertEqual(json.loads((self.root / 'config.json').read_text()), {})
        self.assertEqual((self.root / 'tools/ce-chatgpt-wake/auto_wake.py').read_bytes(), before)
        self.assertTrue((self.root / 'tools/ce-chatgpt-wake/conversation_guard.py').exists())

    def owner_fixture(self):
        import sqlite3
        database = self.base / 'owners.sqlite'
        db = sqlite3.connect(database)
        self.addCleanup(db.close)
        db.executescript('''
CREATE TABLE participant(participant_id,endpoint_adapter,endpoint_id);
CREATE TABLE participant_ownership(participant_id,session_id,expires_at,fencing_token);
CREATE TABLE participant_session(participant_id,session_id,detached_at);
CREATE TABLE exchange_membership(exchange_id,participant_id);
CREATE TABLE exchange(exchange_id,state);
INSERT INTO participant VALUES('sender','pi','pi/fixture'),('recipient','chatgpt','chatgpt/fixture');
INSERT INTO participant_ownership VALUES('sender','sender-session','2099-01-01T00:00:00Z',1),('recipient','recipient-one','2099-01-01T00:00:00Z',2);
INSERT INTO participant_session VALUES('sender','sender-session',NULL),('recipient','recipient-one',NULL);
INSERT INTO exchange_membership VALUES('exchange','sender'),('exchange','recipient');
INSERT INTO exchange VALUES('exchange','OPEN');
''')
        db.commit()
        runtime = {'databasePath': str(database), 'hookSenderAdapter': 'pi', 'hookSenderEndpointId': 'pi/fixture',
                   'hookRecipientAdapter': 'chatgpt', 'hookRecipientEndpointId': 'chatgpt/fixture',
                   'hookExchangeId': 'exchange', 'participantId': 'sender', 'ceSessionId': 'sender-session'}
        return db, runtime

    def test_real_owner_probe_reports_recipient_transfer_as_changed(self):
        db, runtime = self.owner_fixture()
        with mock.patch.object(install.auto_wake, 'resolve_runtime', return_value=runtime):
            first = install.current_owner(self.config)
            db.execute("UPDATE participant_ownership SET session_id='recipient-two',fencing_token=3 WHERE participant_id='recipient'")
            db.execute("UPDATE participant_session SET session_id='recipient-two' WHERE participant_id='recipient'")
            db.commit()
            second = install.current_owner(self.config)
        self.assertNotEqual(first, second)
        self.assertEqual(first['owners']['Recipient']['sessionId'], 'recipient-one')
        self.assertEqual(second['owners']['Recipient']['sessionId'], 'recipient-two')

    def test_real_recipient_takeover_before_reopen_leaves_gate_closed(self):
        db, runtime = self.owner_fixture()
        calls = [0]
        def probe(config):
            calls[0] += 1
            if calls[0] == 3:
                db.execute("UPDATE participant_ownership SET session_id='recipient-two',fencing_token=3 WHERE participant_id='recipient'")
                db.execute("UPDATE participant_session SET session_id='recipient-two' WHERE participant_id='recipient'")
                db.commit()
            return install.current_owner(config)
        self.probe = probe
        with mock.patch.object(install.auto_wake, 'resolve_runtime', return_value=runtime), \
                self.assertRaisesRegex(ValueError, 'OWNER_CHANGED_BEFORE_REOPEN'):
            self.apply()
        self.assertEqual(json.loads((self.root / 'config.json').read_text()), {})

    def test_real_expired_recipient_lease_is_refused(self):
        db, runtime = self.owner_fixture()
        db.execute("UPDATE participant_ownership SET expires_at='2000-01-01T00:00:00Z' WHERE participant_id='recipient'")
        db.commit()
        with mock.patch.object(install.auto_wake, 'resolve_runtime', return_value=runtime), \
                self.assertRaisesRegex(ValueError, 'OWNER_LEASE_EXPIRED'):
            install.current_owner(self.config)

    def test_real_owner_signature_ignores_renewal_but_detects_new_fence(self):
        db, runtime = self.owner_fixture()
        with mock.patch.object(install.auto_wake, 'resolve_runtime', return_value=runtime):
            first = install.current_owner(self.config)
            db.execute("UPDATE participant_ownership SET expires_at='2099-02-01T00:00:00Z'")
            db.commit()
            renewed = install.current_owner(self.config)
            db.execute("UPDATE participant_ownership SET fencing_token=3 WHERE participant_id='recipient'")
            db.commit()
            fenced = install.current_owner(self.config)
        self.assertEqual(first, renewed)
        self.assertNotEqual(first, fenced)

    def test_owner_change_before_reopen_keeps_the_entry_closed(self):
        self.probe = mock.Mock(side_effect=[{'runtimeSessionId': 'first'}, {'runtimeSessionId': 'first'},
                                          {'runtimeSessionId': 'transferred'}])
        with self.assertRaisesRegex(ValueError, 'OWNER_CHANGED_BEFORE_REOPEN'):
            self.apply()
        self.assertEqual(json.loads((self.root / 'config.json').read_text()), {})
        self.assertTrue((self.backup / 'before/config.json').exists())

    def test_close_entry_works_despite_drift_and_unsettled_claims(self):
        result = self.apply()
        (self.root / 'tools/ce-chatgpt-wake/auto_wake.py').write_text('drifted after activation')
        pending = self.root / 'state/msg_pending.json'
        pending.write_text(json.dumps({'event': {}, 'stage': 'ADMITTED'}))
        pending.chmod(0o600)
        report = install.close_entry(self.root, result, process_probe=lambda _: [{'pid': 4242}])
        self.assertEqual(json.loads((self.root / 'config.json').read_text()), {})
        self.assertEqual([item['messageId'] for item in report['unsettledClaims']], ['msg_pending'])
        self.assertIn('tools/ce-chatgpt-wake/auto_wake.py', report['installedDrift'])
        self.assertEqual(report['activeProcesses'], [{'pid': 4242}])

    def test_close_entry_does_not_wait_for_held_desktop_lock_or_failed_probe(self):
        result = self.apply()
        with auto_wake.locked(self.root / 'state/.desktop.lock'):
            report = install.close_entry(self.root, result,
                                         process_probe=mock.Mock(side_effect=OSError('probe unavailable')))
        self.assertEqual(json.loads((self.root / 'config.json').read_text()), {})
        self.assertEqual(report['entry'], 'CLOSED')
        self.assertIsNone(report['activeProcesses'])
        self.assertEqual(report['diagnosticErrors'], ['OSError'])

    def test_close_entry_refuses_an_unrecognized_entry_shape(self):
        result = self.apply()
        (self.root / 'config.json').write_text(json.dumps({'unexpected': True}))
        (self.root / 'config.json').chmod(0o600)
        with self.assertRaisesRegex(ValueError, 'ENTRY_NOT_RECOGNIZED'):
            install.close_entry(self.root, result, process_probe=lambda _: [])
        self.assertEqual(json.loads((self.root / 'config.json').read_text()), {'unexpected': True})

    def test_old_hook_rejects_maintenance_config_before_any_effect(self):
        import subprocess
        import sys
        maintenance = self.base / 'maintenance.json'
        maintenance.write_text('{}')
        result = subprocess.run([sys.executable, '-B', str(Path(__file__).with_name('wake.py')),
                                 '--config', str(maintenance), '--hook'], input=b'{}',
                                capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 1)
        self.assertIn(b'HOOK_CONFIG_INVALID', result.stderr)
        self.assertEqual(list((self.root / 'state').iterdir()), [])

    def test_reviewed_source_drift_refuses_before_entry_change(self):
        (self.source / 'conversation_guard.py').write_text('unreviewed drift')
        with self.assertRaisesRegex(ValueError, 'BASELINE_CHANGED'):
            self.apply()
        self.assertEqual(json.loads((self.root / 'config.json').read_text()), self.outer)
        self.assertFalse(self.backup.exists())

    def test_evidence_write_failure_cannot_reopen_the_entry(self):
        real = install.atomic_write
        def fail_evidence(path, content):
            if path == self.backup / 'activation.json':
                raise OSError('fixture evidence failure')
            real(path, content)
        with mock.patch.object(install, 'atomic_write', side_effect=fail_evidence), self.assertRaises(OSError):
            self.apply()
        self.assertEqual(json.loads((self.root / 'config.json').read_text()), {})

    def test_installed_modules_really_suppress_without_desktop_or_notification(self):
        import subprocess
        import sys
        for name in install.BASELINE_FILES:
            if name in ('config.json', 'auto-wake.json', 'tools/ce-chatgpt-wake/auto_wake.py'):
                continue
            source = Path(__file__).resolve().parents[2] / name
            (self.root / name).write_bytes(source.read_bytes())
            self.baseline['files'][name] = install.sha(self.root / name)
        self.apply()
        program = '''
import json,sys,sqlite3
from pathlib import Path
from unittest import mock
root=Path(sys.argv[1]);sys.path.insert(0,str(root/'tools/ce-chatgpt-wake'))
import auto_wake
config=auto_wake.load_config(root/'auto-wake.json');results=[]
dbpath=root/'synthetic.sqlite'
db=sqlite3.connect(dbpath)
db.executescript('CREATE TABLE message(message_id,exchange_id,idempotency_key); CREATE TABLE audit_event(subject_id,exchange_id,kind,sequence);')
runtime={'databasePath':str(dbpath),'hookExchangeId':'ho_'+'A'*26}
for index,mode in enumerate(('explicit-only','title-match')):
    config['conversationGuard']={'mode':mode}
    mid='msg_'+str(index)*26
    event={'messageId':mid,'sender':{'endpointId':'pi/fixture'},'recipient':{'endpointId':'chatgpt/fixture'}}
    db.execute('INSERT INTO message VALUES(?,?,?)',(mid,runtime['hookExchangeId'],'ordinary-'+str(index)))
    db.execute('INSERT INTO audit_event VALUES(?,?,?,?)',(mid,runtime['hookExchangeId'],'message_created',index+1));db.commit()
    auto_wake.wake.write_state(Path(config['stateDir'])/(mid+'.json'),{'stage':'ADMITTED','event':event})
    with mock.patch.object(auto_wake,'validate_current'), mock.patch.object(auto_wake.wake,'ChatGptCli',side_effect=AssertionError('GUI forbidden')), mock.patch.object(auto_wake.notification,'post',side_effect=AssertionError('notification forbidden')):
        result=auto_wake.work(mid,config,resolve=lambda _: runtime)
    assert result['stage']=='SUPPRESSED'
    results.append(result['conversationGuard']['reason'])
print(json.dumps(results))
'''
        result = subprocess.run([sys.executable, '-B', '-c', program, str(self.root)],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), ['EXPLICIT_ONLY', 'SOURCE_BINDING_UNAVAILABLE'])

    def test_owner_change_during_quiescence_refuses_before_gate(self):
        self.probe = mock.Mock(side_effect=[{'runtimeSessionId': 'first'}, {'runtimeSessionId': 'other'}])
        with self.assertRaisesRegex(ValueError, 'OWNER_CHANGED'):
            self.apply()
        self.assertEqual(json.loads((self.root / 'config.json').read_text()), self.outer)


if __name__ == '__main__':
    unittest.main()
