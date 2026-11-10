"""Real admission/store/journal tests; substitute only runtime/desktop/OS effects."""
import datetime
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

import test_hook

spec = importlib.util.spec_from_file_location('auto_wake', Path(__file__).with_name('auto_wake.py'))
assert spec is not None and spec.loader is not None
auto = importlib.util.module_from_spec(spec)
spec.loader.exec_module(auto)


class AutoWakeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.event = test_hook.event()
        # CHECK_ONLY's real commit/intent boundary has its own integration tests;
        # these fixtures exercise the existing business wake state machine.
        selector = mock.patch('check_only.dispatch', return_value=None)
        selector.start()
        self.addCleanup(selector.stop)
        self.config = {'stateDir': str(self.root / 'state'), 'afterAuditSequence': 0}
        self.runtime = {'hookSenderAdapter': 'pi', 'hookSenderEndpointId': 'pi/session-test',
                        'hookRecipientAdapter': 'chatgpt', 'hookRecipientEndpointId': 'chatgpt/main',
                        'hookExchangeId': self.event['exchangeId'], 'stateDir': self.config['stateDir'],
                        'databasePath': str(self.root / 'store.sqlite'), 'ceSessionId': 'native-session',
                        'participantId': 'p1'}
        self.db = sqlite3.connect(self.runtime['databasePath'])
        self.addCleanup(self.db.close)
        self.db.executescript('''
CREATE TABLE message(message_id, exchange_id, from_endpoint_json, to_endpoint_json,
 payload_digest, payload_length, created_at);
CREATE TABLE exchange(exchange_id, state);
CREATE TABLE audit_event(sequence, kind, subject_id, created_at, outcome);
CREATE TABLE participant(participant_id, endpoint_adapter, endpoint_id);
CREATE TABLE participant_ownership(participant_id, session_id, expires_at);
CREATE TABLE participant_session(participant_id, session_id, detached_at);
CREATE TABLE exchange_membership(exchange_id, participant_id);
''')
        e = self.event
        self.db.execute('INSERT INTO message VALUES(?,?,?,?,?,?,?)',
                        (e['messageId'], e['exchangeId'], json.dumps(e['sender']), json.dumps(e['recipient']),
                         e['payloadDigest'], e['payloadLength'], e['createdAt']))
        self.db.execute('INSERT INTO exchange VALUES(?,?)', (e['exchangeId'], 'OPEN'))
        self.db.execute('INSERT INTO audit_event VALUES(?,?,?,?,?)',
                        (1, 'message_created', e['messageId'], e['createdAt'], None))
        expiry = (datetime.datetime.now(datetime.UTC) + datetime.timedelta(hours=1)).isoformat()
        for participant, endpoint, session in [('p1', e['sender'], 'native-session'),
                                                ('p2', e['recipient'], 'chat-session')]:
            self.db.execute('INSERT INTO participant VALUES(?,?,?)', (participant, endpoint['adapter'], endpoint['endpointId']))
            self.db.execute('INSERT INTO participant_ownership VALUES(?,?,?)', (participant, session, expiry))
            self.db.execute('INSERT INTO participant_session VALUES(?,?,NULL)', (participant, session))
            self.db.execute('INSERT INTO exchange_membership VALUES(?,?)', (e['exchangeId'], participant))
        self.db.commit()
        self.resolve = lambda _: self.runtime.copy()
        self.spawn = mock.Mock()

    def admit(self, **overrides):
        return auto.enqueue(test_hook.encode(self.event), self.config,
                            resolve=overrides.pop('resolve', self.resolve),
                            spawn=overrides.pop('spawn', self.spawn), **overrides)

    def worker(self, attempt, fallback, guarded=False):
        if guarded:
            return auto.work(self.event['messageId'], self.config, resolve=self.resolve,
                             attempt=attempt, fallback=fallback)
        # Preserve dormant desktop state-machine coverage without claiming a real
        # source binding exists. New guard/integration tests never use this bypass.
        with mock.patch.object(auto.conversation_guard, 'automatic_decision', return_value=None):
            return auto.work(self.event['messageId'], self.config, resolve=self.resolve,
                             attempt=attempt, fallback=fallback)

    def test_committed_message_claim_precedes_spawn_and_duplicate_cannot_spawn(self):
        def spawn(message_id, config):
            saved = auto.read_private(auto.claim_path(config, message_id))
            self.assertEqual(saved['stage'], 'ADMITTED')
            self.assertEqual(saved['event'], self.event)
        self.spawn.side_effect = spawn
        self.assertEqual(self.admit()['dispatch'], 'QUEUED')
        self.assertEqual(self.admit()['dispatch'], 'QUEUED')
        self.spawn.assert_called_once()

    def test_unknown_spawn_failure_keeps_claim_and_never_retries(self):
        self.spawn.side_effect = OSError('unknown spawn')
        self.assertEqual(self.admit()['dispatch'], 'UNKNOWN')
        self.assertEqual(self.admit()['dispatch'], 'UNKNOWN')
        self.spawn.assert_called_once()

    def test_metadata_mismatch_closed_exchange_detached_or_expired_lease_denied(self):
        mutations = ["UPDATE message SET payload_digest='wrong'",
                     "UPDATE exchange SET state='CLOSED'",
                     "UPDATE participant_session SET detached_at='now'",
                     "UPDATE participant_ownership SET expires_at='2000-01-01T00:00:00Z'",
                     "UPDATE participant_ownership SET session_id='wrong'",
                     "DELETE FROM exchange_membership",
                     "UPDATE audit_event SET subject_id='wrong'"]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                self.apply_mutation(mutation)
                # A separate read-only connection must see the mutation.
                self.db.commit()
                with self.assertRaises(ValueError):
                    self.admit()
                self.spawn.assert_not_called()
                # Restore the modified fixture before the next independent boundary check.
                self.tearDown_fixture(mutation)

    def test_worker_finish_during_spawn_cannot_be_overwritten_by_admission(self):
        attempt = mock.Mock(return_value={'stage': 'NOTICE_OBSERVED', 'result': {'noticeSubmission': 'OBSERVED'}})
        fallback = mock.Mock()
        self.spawn.side_effect = lambda *_: self.worker(attempt, fallback)
        self.admit()
        self.assertEqual(auto.read_private(auto.claim_path(self.config, self.event['messageId']))['stage'], 'OBSERVED')
        self.worker(attempt, fallback)
        attempt.assert_called_once()

    def test_missing_dispatch_result_is_unknown_and_never_spawns_again(self):
        self.admit()
        auto.dispatch_path(self.config, self.event['messageId']).unlink()
        self.assertEqual(self.admit()['dispatch'], 'UNKNOWN')
        self.spawn.assert_called_once()

    def test_default_guard_suppresses_all_automatic_and_button_paths(self):
        self.admit()
        attempt = mock.Mock(return_value={'stage': 'NOTICE_OBSERVED', 'result': {'noticeSubmission': 'OBSERVED'}})
        fallback = mock.Mock(return_value={'state': 'DISMISSED'})
        result = self.worker(attempt, fallback, guarded=True)
        self.assertEqual(result['stage'], 'SUPPRESSED')
        self.assertEqual(result['conversationGuard']['reason'], 'EXPLICIT_ONLY')
        attempt.assert_not_called()
        fallback.assert_not_called()

    def test_title_mode_without_trustworthy_initiation_binding_never_touches_desktop(self):
        self.config['conversationGuard'] = {'mode': 'title-match'}
        self.admit()
        attempt = mock.Mock(return_value={'stage': 'NOTICE_OBSERVED', 'result': {'noticeSubmission': 'OBSERVED'}})
        fallback = mock.Mock(return_value={'state': 'DISMISSED'})
        result = self.worker(attempt, fallback, guarded=True)
        self.assertEqual(result['stage'], 'SUPPRESSED')
        self.assertEqual(result['conversationGuard']['reason'], 'SOURCE_BINDING_UNAVAILABLE')
        attempt.assert_not_called()
        fallback.assert_not_called()
        self.worker(attempt, fallback, guarded=True)
        attempt.assert_not_called()

    def test_activation_watermark_rejects_pre_activation_message(self):
        self.config['afterAuditSequence'] = 1
        with self.assertRaisesRegex(ValueError, 'BEFORE_ACTIVATION'):
            self.admit()
        self.spawn.assert_not_called()

    def test_valid_takeover_to_another_ce_session_rejects_old_native_binding(self):
        self.runtime['ceSessionId'] = 'native-session'
        self.db.execute("UPDATE participant_ownership SET session_id='replacement-session' WHERE participant_id='p1'")
        self.db.execute("UPDATE participant_session SET session_id='replacement-session' WHERE participant_id='p1'")
        self.db.commit()
        with self.assertRaisesRegex(ValueError, 'SENDER_SESSION_CHANGED'):
            self.admit()
        self.spawn.assert_not_called()

    def test_opt_in_hook_routes_once_without_legacy_notification(self):
        import contextlib
        import io
        import sys
        outer = self.root / 'config.json'
        outer.write_text(json.dumps({'autoWakeConfig': str(self.root / 'auto-wake.json')}))
        outer.chmod(0o600)
        configured = dict(self.config, ownerDirectory=str(self.root))
        with mock.patch('auto_wake.load_config', return_value=configured), \
                mock.patch('auto_wake.enqueue', return_value={'dispatch': 'QUEUED'}) as enqueue, \
                mock.patch.object(test_hook.wake, 'notify_hook', side_effect=AssertionError('legacy owner')), \
                mock.patch.object(sys, 'stdin', io.TextIOWrapper(io.BytesIO(test_hook.encode(self.event)))), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(test_hook.wake.main(['--config', str(outer), '--hook']), 0)
        enqueue.assert_called_once()

    def apply_mutation(self, mutation):
        if 'payload_digest' in mutation:
            self.db.execute("UPDATE message SET payload_digest='wrong'")
        elif 'exchange SET' in mutation:
            self.db.execute("UPDATE exchange SET state='CLOSED'")
        elif 'detached_at' in mutation:
            self.db.execute("UPDATE participant_session SET detached_at='now'")
        elif 'expires_at' in mutation:
            self.db.execute("UPDATE participant_ownership SET expires_at='2000-01-01T00:00:00Z'")
        elif 'session_id' in mutation:
            self.db.execute("UPDATE participant_ownership SET session_id='wrong'")
        elif 'exchange_membership' in mutation:
            self.db.execute('DELETE FROM exchange_membership')
        else:
            self.db.execute("UPDATE audit_event SET subject_id='wrong'")
        self.db.commit()

    def tearDown_fixture(self, mutation):
        if 'payload_digest' in mutation:
            self.db.execute('UPDATE message SET payload_digest=?', (self.event['payloadDigest'],))
        elif 'exchange SET' in mutation:
            self.db.execute("UPDATE exchange SET state='OPEN'")
        elif 'detached_at' in mutation:
            self.db.execute('UPDATE participant_session SET detached_at=NULL')
        elif 'expires_at' in mutation:
            self.db.execute('UPDATE participant_ownership SET expires_at=?',
                            ((datetime.datetime.now(datetime.UTC) + datetime.timedelta(hours=1)).isoformat(),))
        elif 'session_id' in mutation:
            self.db.execute("UPDATE participant_ownership SET session_id=CASE participant_id WHEN 'p1' THEN 'native-session' ELSE 'chat-session' END")
        elif 'exchange_membership' in mutation:
            self.db.executemany('INSERT INTO exchange_membership VALUES(?,?)',
                                [(self.event['exchangeId'], p) for p in ('p1', 'p2')])
        else:
            self.db.execute('UPDATE audit_event SET subject_id=?', (self.event['messageId'],))
        self.db.commit()

    def test_wrong_runtime_sender_or_stale_event_has_no_claim_or_effect(self):
        self.runtime['hookSenderEndpointId'] = 'pi/different'
        with self.assertRaisesRegex(ValueError, 'SENDER_DENIED'):
            self.admit()
        self.runtime['hookSenderEndpointId'] = 'pi/session-test'
        self.event['createdAt'] = '2000-01-01T00:00:00Z'
        with self.assertRaisesRegex(ValueError, 'EVENT_STALE'):
            self.admit()
        self.spawn.assert_not_called()

    def test_observed_auto_wake_has_no_notification_and_cannot_repeat(self):
        self.admit()
        attempt = mock.Mock(return_value={'stage': 'NOTICE_OBSERVED', 'result': {'noticeSubmission': 'OBSERVED'}})
        fallback = mock.Mock()
        result = self.worker(attempt, fallback)
        self.assertEqual(result['stage'], 'OBSERVED')
        self.worker(attempt, fallback)
        attempt.assert_called_once()
        fallback.assert_not_called()

    def test_only_proven_no_input_allows_one_fallback(self):
        self.admit()
        attempt = mock.Mock(return_value={'stage': 'OBSERVING', 'result': {'noticeSubmission': 'NOT_ATTEMPTED'}})
        fallback = mock.Mock(return_value={'state': 'DISMISSED'})
        self.worker(attempt, fallback)
        self.worker(attempt, fallback)
        attempt.assert_called_once()
        fallback.assert_called_once()

    def test_possible_input_prevents_fallback_even_when_result_says_not_attempted(self):
        self.admit()
        attempt = mock.Mock(return_value={'stage': 'INPUT_MAY_HAVE_OCCURRED', 'result': {'noticeSubmission': 'NOT_ATTEMPTED'}})
        fallback = mock.Mock()
        self.assertEqual(self.worker(attempt, fallback)['stage'], 'UNKNOWN')
        fallback.assert_not_called()

    def test_attempt_exception_or_missing_proof_never_allows_fallback(self):
        self.admit()
        fallback = mock.Mock()
        self.assertEqual(self.worker(mock.Mock(side_effect=OSError('unknown')), fallback)['stage'], 'UNKNOWN')
        fallback.assert_not_called()

    def test_authority_loss_between_admission_and_worker_prevents_all_effects(self):
        self.admit()
        self.db.execute("UPDATE exchange SET state='CLOSED'")
        self.db.commit()
        attempt, fallback = mock.Mock(), mock.Mock()
        with self.assertRaises(ValueError):
            self.worker(attempt, fallback)
        attempt.assert_not_called()
        fallback.assert_not_called()

    def test_actual_desktop_attempt_unknown_fill_is_never_offered_a_fallback(self):
        import test_wake
        desktop = test_wake.Desktop()
        class FakeCli:
            def __init__(self, _):
                pass
            def call(self, _):
                return {'data': [{'id': 'w-1', 'title': 'display', 'pid': 10, 'process_instance': 'generation'}]}
            def snapshot(self):
                return desktop.snapshot()
            def fill(self, ref, text):
                desktop.fill(ref, text)
                raise OSError('possible input')
            def submit(self, ref):
                desktop.submit(ref)
        self.config.update(agentDesktop='/fake/desktop', conversationMarker='HANDOFF-CE-CHATGPT-WAKE-01', maxWaitSeconds=1)
        self.admit()
        fallback = mock.Mock()
        with mock.patch.object(auto.wake, 'ChatGptCli', FakeCli), \
                mock.patch.object(auto, 'resolve_runtime', self.resolve), \
                mock.patch.object(auto.tempfile, 'mkdtemp', return_value=str(self.root / 'short-tmp')):
            result = self.worker(auto.attempt_wake, fallback)
        self.assertEqual(result['auto']['stage'], 'INPUT_MAY_HAVE_OCCURRED')
        self.assertEqual(result['stage'], 'UNKNOWN')
        fallback.assert_not_called()
        self.assertEqual(desktop.sends, 0)

    def test_actual_desktop_preflight_busy_wrong_marker_or_draft_proves_no_input(self):
        import test_wake
        self.config.update(agentDesktop='/fake/desktop', conversationMarker='HANDOFF-CE-CHATGPT-WAKE-01', maxWaitSeconds=1)
        self.admit()
        for scenario in ('busy', 'marker', 'draft'):
            desktop = test_wake.Desktop()
            original = desktop.snapshot
            class FakeCli:
                def __init__(self, _):
                    pass
                def call(self, _):
                    return {'data': [{'id': 'w-1', 'title': 'display', 'pid': 10, 'process_instance': 'generation'}]}
                def snapshot(self):
                    value = original()
                    children = value['data']['tree']['children'][0]['children']
                    if scenario == 'busy':
                        children[-1]['name'] = '停止'
                    elif scenario == 'marker':
                        children[0]['name'] = 'wrong-marker'
                    else:
                        children[-2]['value'] = 'private draft'
                    return value
                def fill(self, *_):
                    raise AssertionError('input forbidden')
                def submit(self, *_):
                    raise AssertionError('submit forbidden')
            record = {'testId': 'CE-WAKE-AUTO-' + self.event['messageId'][4:],
                      'messageId': self.event['messageId'], 'to': 'chatgpt/main',
                      'replyTo': 'pi/session-test', 'disposition': 'CREATED'}
            with self.subTest(scenario=scenario), mock.patch.object(auto.wake, 'ChatGptCli', FakeCli), \
                    mock.patch.object(auto.tempfile, 'mkdtemp', return_value=str(self.root / 'short-tmp')):
                result = auto.attempt_wake(record, self.config, self.runtime, scenario)
            self.assertEqual(result['stage'], 'OBSERVING')
            self.assertEqual(result['result']['noticeSubmission'], 'NOT_ATTEMPTED')

    def test_symlink_claim_or_legacy_attempt_cannot_be_replayed(self):
        Path(self.config['stateDir']).mkdir(mode=0o700)
        claim = auto.claim_path(self.config, self.event['messageId'])
        target = self.root / 'untouched'
        target.write_text('unchanged')
        claim.symlink_to(target)
        with self.assertRaises((ValueError, OSError)):
            self.admit()
        self.assertEqual(target.read_text(), 'unchanged')
        self.spawn.assert_not_called()


if __name__ == '__main__':
    unittest.main()
