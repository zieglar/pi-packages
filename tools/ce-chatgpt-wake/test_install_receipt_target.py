"""A fake owner verifies the closed-gate install; no CE or desktop process is invoked."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location('receipt_installer', Path(__file__).with_name('install_receipt_target.py'))
assert spec and spec.loader
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class ReceiptInstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='/private/tmp')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / 'owner'
        self.package = self.base / 'package'
        self.source = self.base / 'source'
        self.package_source = self.base / 'package-source'
        self.backup = self.base / 'backup'
        for directory in (self.root, self.root / 'state', self.root / 'tools',
                          self.root / 'tools/ce-chatgpt-wake', self.root / 'tools/ce-ovis-desktop',
                          self.package, self.package / 'pi-extension', self.source, self.package_source):
            directory.mkdir(mode=0o700)
        for name in installer.ROOT_BASE:
            if name.endswith('/receipt_target.py'):
                continue
            self.put(self.root / name, 'old ' + name)
        for name in installer.PACKAGE_FILES:
            if name != 'desktop-target.ts':
                self.put(self.package / 'pi-extension' / name, 'old ' + name, 0o644)
        for name in installer.OWNER_FILES:
            self.put(self.source / name, 'reviewed ' + name)
        for name in installer.PACKAGE_FILES:
            self.put(self.package_source / name, 'reviewed ' + name)
        self.outer = {'autoWakeConfig': str(self.root / 'auto-wake.json')}
        self.config = {'stateDir': str(self.root / 'state'), 'profilePath': str(self.base / 'profile'),
                       'packageRoot': str(self.package), 'nativeSessionFile': str(self.base / 'native'),
                       'python': '/usr/bin/python3', 'node': '/usr/bin/node', 'agentDesktop': '/unused/desktop',
                       'terminalNotifier': '/unused/notifier', 'ownerDirectory': str(self.root),
                       'conversationMarker': 'fixture-marker', 'maxWaitSeconds': 60,
                       'notificationTimeoutSeconds': 120, 'afterAuditSequence': 145,
                       'conversationGuard': {'mode': 'explicit-only'}}
        self.put(self.root / 'config.json', json.dumps(self.outer))
        self.put(self.root / 'auto-wake.json', json.dumps(self.config))
        self.baseline = {
            'owner': {name: installer.sha(self.root / name, True) if (self.root / name).exists() else None
                      for name in installer.ROOT_BASE},
            'package': {name: installer.sha(self.package / 'pi-extension' / name)
                        if (self.package / 'pi-extension' / name).exists() else None for name in installer.PACKAGE_FILES},
            'sourceOwner': {name: installer.sha(self.source / name, True) for name in installer.OWNER_FILES},
            'sourcePackage': {name: installer.sha(self.package_source / name, True) for name in installer.PACKAGE_FILES},
        }
        self.owner = {'runtimeSessionId': 'fixture-session', 'policyDigest': 'a' * 64}

    def put(self, path, data, mode=0o600):
        path.write_text(data)
        path.chmod(mode)

    def apply(self, **overrides):
        probes = {'owner_probe': lambda _: self.owner, 'process_probe': lambda _: [], 'cutoff_probe': lambda _: 211}
        probes.update(overrides)
        return installer.install(self.root, self.package, self.source, self.package_source,
                                 self.baseline, self.backup, **probes)

    def test_closed_gate_install_keeps_explicit_only_and_backs_up_exact_files(self):
        real = installer.atomic_write
        writes = []

        def observe(path, data):
            if path.parent in (self.root / 'tools/ce-chatgpt-wake', self.package / 'pi-extension'):
                self.assertEqual(json.loads((self.root / 'config.json').read_text()), {})
                writes.append(path.name)
            real(path, data)

        with mock.patch.object(installer, 'atomic_write', side_effect=observe):
            result = self.apply()
        self.assertEqual(result['phase'], 'INSTALLED_EXPLICIT_ONLY_RELOAD_REQUIRED')
        self.assertEqual(json.loads((self.root / 'config.json').read_text()), self.outer)
        config = json.loads((self.root / 'auto-wake.json').read_text())
        self.assertEqual(config['conversationGuard'], {'mode': 'explicit-only', 'targetSelection': 'desktop-at-intake',
                                                       'captureAfterAuditSequence': 211})
        self.assertEqual(writes, [*installer.OWNER_FILES, *installer.PACKAGE_FILES])
        for name, digest in result['before'].items():
            if digest is not None:
                self.assertEqual(installer.sha(self.backup / 'before' / name, True), digest)
        self.assertEqual(result['beforeModes']['package/index.ts'], 0o644)
        for name in installer.OWNER_FILES:
            self.assertEqual(installer.sha(self.root / 'tools/ce-chatgpt-wake' / name, True), self.baseline['sourceOwner'][name])
        for name in installer.PACKAGE_FILES:
            self.assertEqual(installer.sha(self.package / 'pi-extension' / name, True), self.baseline['sourcePackage'][name])

    def test_drift_or_preexisting_new_file_refuses_before_closing(self):
        self.put(self.root / 'tools/ce-chatgpt-wake/receipt_target.py', 'unrelated existing file')
        with self.assertRaisesRegex(ValueError, 'BASELINE_CHANGED'):
            self.apply()
        self.assertEqual(json.loads((self.root / 'config.json').read_text()), self.outer)
        self.assertFalse(self.backup.exists())

    def test_active_worker_and_desktop_lock_refuse_before_closing(self):
        with self.assertRaisesRegex(ValueError, 'ACTIVE_WAKE'):
            self.apply(process_probe=lambda _: [{'pid': 123}])
        with installer.gate.auto_wake.locked(self.root / 'state/.desktop.lock'), self.assertRaises(BlockingIOError):
            self.apply()
        self.assertEqual(json.loads((self.root / 'config.json').read_text()), self.outer)
        self.assertFalse(self.backup.exists())

    def test_owner_change_after_close_leaves_gate_closed(self):
        calls = 0
        def owner(_):
            nonlocal calls
            calls += 1
            return self.owner if calls < 3 else {'runtimeSessionId': 'different'}
        with self.assertRaisesRegex(ValueError, 'OWNER_CHANGED'):
            self.apply(owner_probe=owner)
        self.assertEqual(json.loads((self.root / 'config.json').read_text()), {})
        self.assertTrue((self.backup / 'before/owner/config.json').exists())

    def test_write_failure_after_close_preserves_backup_and_closed_gate(self):
        real = installer.atomic_write
        def fail(path, data):
            if path == self.root / 'tools/ce-chatgpt-wake/wake.py':
                raise OSError('fixture failure')
            real(path, data)
        with mock.patch.object(installer, 'atomic_write', side_effect=fail), self.assertRaises(OSError):
            self.apply()
        self.assertEqual(json.loads((self.root / 'config.json').read_text()), {})
        self.assertEqual(json.loads((self.backup / 'installation.json').read_text())['phase'], 'CLOSED')
        self.assertTrue((self.backup / 'before/owner/auto-wake.json').exists())

    def test_final_record_failure_never_reopens_the_gate(self):
        real = installer.atomic_write
        failed = False
        def fail_final_record(path, data):
            nonlocal failed
            if failed or (path == self.backup / 'installation.json' and b'READY_TO_REOPEN_EXPLICIT_ONLY' in data):
                failed = True
                raise OSError('persistent fixture failure')
            real(path, data)
        with mock.patch.object(installer, 'atomic_write', side_effect=fail_final_record), self.assertRaises(OSError):
            self.apply()
        self.assertEqual(json.loads((self.root / 'config.json').read_text()), {})

    def test_reopen_post_rename_failure_removes_entry_without_another_write(self):
        real = installer.atomic_write
        failed = False
        def fail_reopen(path, data):
            nonlocal failed
            if failed:
                raise OSError('persistent fixture failure')
            real(path, data)
            if path == self.root / 'config.json' and data != b'{}\n':
                failed = True
                raise OSError('fixture fsync failure after replace')
        with mock.patch.object(installer, 'atomic_write', side_effect=fail_reopen), self.assertRaises(OSError):
            self.apply()
        self.assertTrue(failed)
        self.assertFalse((self.root / 'config.json').exists())

    def test_operational_rollback_closes_ingress_and_preserves_code_and_journals(self):
        result = self.apply()
        before = (self.root / 'tools/ce-chatgpt-wake/auto_wake.py').read_bytes()
        report = installer.gate.close_entry(self.root, result, process_probe=lambda _: [])
        self.assertEqual(report['entry'], 'CLOSED')
        self.assertEqual(report['installedDrift'], [])
        self.assertEqual(json.loads((self.root / 'config.json').read_text()), {})
        self.assertEqual((self.root / 'tools/ce-chatgpt-wake/auto_wake.py').read_bytes(), before)

    def test_pending_claim_is_not_cancelled_or_overwritten(self):
        claim = self.root / 'state/msg_fixture.json'
        self.put(claim, json.dumps({'stage': 'UNKNOWN'}))
        with self.assertRaisesRegex(ValueError, 'UNSETTLED_WAKE'):
            self.apply()
        self.assertEqual(json.loads((self.root / 'config.json').read_text()), self.outer)
        self.assertEqual(json.loads(claim.read_text()), {'stage': 'UNKNOWN'})

    def test_source_drift_refuses_before_gate_change(self):
        self.put(self.source / 'wake.py', 'unreviewed')
        with self.assertRaisesRegex(ValueError, 'BASELINE_CHANGED'):
            self.apply()
        self.assertEqual(json.loads((self.root / 'config.json').read_text()), self.outer)
        self.assertFalse(self.backup.exists())

    def test_invalid_cutoff_keeps_gate_closed(self):
        with self.assertRaisesRegex(ValueError, 'CUTOFF_INVALID'):
            self.apply(cutoff_probe=lambda _: -1)
        self.assertEqual(json.loads((self.root / 'config.json').read_text()), {})


if __name__ == '__main__':
    unittest.main()
