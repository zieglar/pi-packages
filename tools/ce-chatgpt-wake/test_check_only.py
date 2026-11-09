import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import check_only as check
import auto_wake
import test_ownership_feedback as fixtures
from test_ownership_guard import REQUEST, OUT, IN, SCOPE
from test_wake import Desktop


class CheckOnlyTests(unittest.TestCase):
    def setUp(self):
        self.f = fixtures.FeedbackBridgeTests()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.cfg = self.f.cfg
        self.runtime = {**self.f.runtime, 'ceSessionId': 'synthetic-ce', 'participantId': 'synthetic-participant',
                        'policyDigest': 'a' * 64}
        self.f.private(Path(self.cfg['ownerDirectory']) / 'config.json', {'autoWakeConfig': str(self.f.config_path)})
        policy = Path(str(self.cfg['profilePath']) + '.native-inbound') / (hashlib.sha256(self.f.sid.encode()).hexdigest() + '.json')
        policy.parent.mkdir(mode=0o700)
        self.sidecar = Path(str(policy) + '.task-ownership.json')
        self.f.private(self.sidecar, {'schemaVersion': 1, 'registryDirectory': str(self.f.store.root),
                                     'observerConfig': str(self.f.config_path)})
        (self.f.store.root / 'metadata' / (OUT + '.json')).unlink()
        self.claim = {'auditSequence': 200, 'metadata': {'messageId': REQUEST}}

    def prepare(self):
        with mock.patch.object(check.auto_wake, 'resolve_runtime', return_value=self.runtime), \
             mock.patch.object(check.receipt_target, 'inbound_claim', return_value=self.claim):
            return check.prepare(REQUEST, 'synthetic-notify', self.cfg)

    def commit(self, key):
        self.f.db.execute('INSERT INTO message VALUES(?,?,?,?,?,?,?,?)',
                          (OUT, SCOPE['exchangeId'], json.dumps({'adapter': 'pi', 'endpointId': SCOPE['from']}),
                           json.dumps({'adapter': 'chatgpt', 'endpointId': SCOPE['to']}), '0' * 64, 1,
                           '2026-11-08T06:00:01Z', key))
        self.f.db.execute('INSERT INTO audit_event VALUES(?,?,?,?)', (202, SCOPE['exchangeId'], 'message_created', OUT))
        self.f.db.commit()
        return {'messageId': OUT, 'exchangeId': SCOPE['exchangeId'],
                'sender': {'adapter': 'pi', 'endpointId': SCOPE['from']},
                'recipient': {'adapter': 'chatgpt', 'endpointId': SCOPE['to']}}

    def run_prepared(self, *, factory=None, notifier=None):
        prepared = self.prepare()
        event = self.commit(prepared['idempotencyKey'])
        def default_factory(cfg):
            cfg['windowId'] = 'w-1'
            return Desktop()
        return check.dispatch(event, self.cfg, self.runtime, desktop_factory=factory or default_factory,
                              notifier=notifier or (lambda request: '@CLOSED'), authority=lambda: None)

    def test_notification_fallback_is_disabled_without_consuming_an_old_button(self):
        notify = mock.Mock(return_value='检查当前会话')
        def unavailable(cfg):
            raise ValueError('CHATGPT_NOT_FOREGROUND')
        result = self.run_prepared(factory=unavailable, notifier=notify)
        self.assertEqual(result['notification'], 'DISABLED')
        self.assertEqual(result['noticeSubmission'], 'NOT_ATTEMPTED')
        notify.assert_not_called()
        self.assertEqual(self.f.store.state(OUT)['manual'], 'NOT_ATTEMPTED')


    def test_disabled_fallback_never_retries_unknown_submit(self):
        desk = Desktop()
        desk.unknown = True
        notify = mock.Mock(return_value='检查当前会话')
        def factory(cfg):
            cfg['windowId'] = 'w-1'
            return desk
        result = self.run_prepared(factory=factory, notifier=notify)
        self.assertEqual(result['noticeSubmission'], 'UNKNOWN')
        self.assertEqual(result['notification'], 'DISABLED')
        repeated = check.dispatch({'messageId': OUT}, self.cfg, self.runtime,
                                  desktop_factory=factory, notifier=notify, authority=lambda: None)
        self.assertEqual(repeated, result)
        self.assertEqual(desk.sends, 1)
        self.assertEqual(self.f.store.state(OUT)['manual'], 'NOT_ATTEMPTED')
        notify.assert_not_called()


    def test_prepare_is_metadata_only_explicit_named_action_and_stable_before_send(self):
        a = self.prepare()
        b = self.prepare()
        self.assertEqual(a, b)
        self.assertEqual(a['deliveryMode'], 'CHECK_ONLY')
        self.assertEqual(a['status'], 'PREPARED')
        self.assertEqual(self.cfg['conversationGuard'], {'mode': 'explicit-only'})
        paths = list((self.f.store.root / 'check-only-intents').glob('request-*.json'))
        self.assertEqual(len(paths), 1)
        self.assertEqual(paths[0].stat().st_mode & 0o777, 0o600)
        self.assertEqual(list((self.f.store.root / 'metadata').iterdir()), [])

    def test_prepare_after_actual_commit_does_not_issue_another_key(self):
        p = self.prepare()
        self.commit(p['idempotencyKey'])
        again = self.prepare()
        self.assertEqual(again['status'], 'ALREADY_COMMITTED')
        self.assertEqual(again['messageId'], OUT)
        self.assertNotIn('idempotencyKey', again)

    def test_no_intake_capture_or_original_title_needed(self):
        with mock.patch.object(check.receipt_target, 'captured_target', side_effect=AssertionError('title binding used')):
            self.assertEqual(self.prepare()['status'], 'PREPARED')

    def test_closed_outer_entry_and_missing_native_receive_refuse(self):
        self.f.private(Path(self.cfg['ownerDirectory']) / 'config.json', {})
        with self.assertRaisesRegex(ValueError, 'CHECK_ONLY_DISABLED'):
            self.prepare()
        self.f.private(Path(self.cfg['ownerDirectory']) / 'config.json', {'autoWakeConfig': str(self.f.config_path)})
        with mock.patch.object(check.auto_wake, 'resolve_runtime', return_value=self.runtime), \
             mock.patch.object(check.receipt_target, 'inbound_claim', side_effect=ValueError('REQUEST_NOT_RECEIVED')):
            with self.assertRaisesRegex(ValueError, 'REQUEST_NOT_RECEIVED'):
                check.prepare(REQUEST, 'synthetic-notify', self.cfg)

    def test_terminal_control_is_not_a_new_notification_request(self):
        self.claim['association'] = {'kind': 'FEEDBACK'}
        with self.assertRaisesRegex(ValueError, 'CONTROL_FEEDBACK_IS_TERMINAL'):
            self.prepare()

    def test_unprepared_reserved_key_never_calls_desktop_or_notifier(self):
        event = self.commit('ce-check-only:' + 'f' * 64)
        result = check.dispatch(event, self.cfg, self.runtime,
                                desktop_factory=lambda cfg: self.fail('desktop called'),
                                notifier=lambda req: self.fail('notification called'), authority=lambda: None)
        self.assertEqual(result['stage'], 'SUPPRESSED')

    def test_ordinary_key_keeps_existing_explicit_only_behavior(self):
        event = self.commit('ordinary-result')
        self.assertIsNone(check.dispatch(event, self.cfg, self.runtime,
                                        desktop_factory=lambda cfg: self.fail('desktop called')))

    def test_observed_prompt_contains_only_fixed_identifiers_and_is_once(self):
        desk = Desktop()
        def factory(cfg):
            cfg['windowId'] = 'w-1'
            return desk
        p = self.prepare()
        event = self.commit(p['idempotencyKey'])
        for _ in range(2):
            r = check.dispatch(event, self.cfg, self.runtime, desktop_factory=factory,
                               notifier=lambda req: self.fail('fallback called'), authority=lambda: None)
            self.assertEqual(r['stage'], 'OBSERVED')
        self.assertEqual(desk.sends, 1)
        self.assertIn('ce_task_owner', desk.notice)
        self.assertNotIn('ce_inbox_list', desk.notice)
        self.assertNotIn('synthetic-project', desk.notice)

    def test_registered_match_check_only_prompt_never_authorizes_payload_read(self):
        desk = Desktop()
        def factory(cfg):
            cfg['windowId'] = 'w-1'
            return desk
        result = self.run_prepared(factory=factory)
        self.assertEqual(result['stage'], 'OBSERVED')
        self.assertEqual(self.f.store.projection(OUT)['ownerStatus'], 'REGISTERED')
        self.assertIn('MATCH 后仍不得读取任何消息正文', desk.notice)
        self.assertNotIn('才可调用 ce_read_payload', desk.notice)

    def test_missing_owner_still_allows_metadata_check_not_payload_authority(self):
        (self.f.store.root / 'owners' / (REQUEST + '.json')).unlink()
        r = self.run_prepared()
        self.assertEqual(r['stage'], 'OBSERVED')
        p = self.f.store.projection(OUT)
        self.assertEqual(p['ownerStatus'], 'UNVERIFIED')

    @mock.patch.object(check, 'NOTIFICATION_FALLBACK_ENABLED', True)
    def test_busy_before_input_has_one_real_action_button_fallback(self):
        count = []
        desk = Desktop()
        def factory(cfg):
            cfg['windowId'] = 'w-1'
            count.append(1)
            if len(count) == 1:
                raise ValueError('CHATGPT_NOT_FOREGROUND')
            return desk
        posted = []
        def notifier(req):
            posted.append(req)
            return req['action']
        r = self.run_prepared(factory=factory, notifier=notifier)
        self.assertEqual(r['stage'], 'OBSERVED')
        self.assertEqual(desk.sends, 1)
        self.assertIn('MATCH 后仍不得读取任何消息正文', desk.notice)
        self.assertEqual(len(posted), 1)
        self.assertIn(OUT, posted[0]['group'])
        self.assertEqual(r['deliveryMode'], 'CHECK_ONLY')

    @mock.patch.object(check, 'NOTIFICATION_FALLBACK_ENABLED', True)
    def test_body_click_close_timeout_do_not_authorize_input(self):
        for outcome in ('@ACTIONCLICKED', '@CLOSED', '@TIMEOUT', ''):
            with self.subTest(outcome=outcome):
                # Each independent request fixture is isolated; no action is retried.
                other = CheckOnlyTests('runTest')
                other.setUp()
                try:
                    calls = []
                    def factory(cfg):
                        calls.append(1)
                        raise ValueError('CHATGPT_BUSY')
                    r = other.run_prepared(factory=factory, notifier=lambda req: outcome)
                    self.assertEqual(r['stage'], 'SUPPRESSED')
                    self.assertEqual(len(calls), 1)
                finally:
                    other.doCleanups()

    @mock.patch.object(check, 'NOTIFICATION_FALLBACK_ENABLED', True)
    def test_unknown_input_or_submit_never_retries_even_after_action_button(self):
        for boundary in ('fill', 'submit'):
            with self.subTest(boundary=boundary):
                other = CheckOnlyTests('runTest')
                other.setUp()
                try:
                    desk = Desktop()
                    calls = []
                    if boundary == 'fill':
                        def fill(ref, text):
                            desk.draft = text
                            raise TimeoutError()
                        desk.fill = fill
                    else:
                        desk.unknown = True
                    def factory(cfg):
                        calls.append(1)
                        cfg['windowId'] = 'w-1'
                        return desk
                    posted = []
                    r = other.run_prepared(factory=factory, notifier=lambda req: posted.append(req) or req['action'])
                    self.assertEqual(r['stage'], 'UNKNOWN')
                    self.assertEqual(len(calls), 1)
                    self.assertEqual(len(posted), 1)
                    self.assertEqual(desk.sends, 0 if boundary == 'fill' else 1)
                    self.assertIn('不会重试', posted[0]['message'])
                finally:
                    other.doCleanups()

    @mock.patch.object(check, 'NOTIFICATION_FALLBACK_ENABLED', True)
    def test_button_cannot_reopen_operator_opt_out(self):
        prepared = self.prepare()
        event = self.commit(prepared['idempotencyKey'])
        closed = []
        calls = []
        def authority():
            if closed:
                raise ValueError('CHECK_ONLY_DISABLED')
        def factory(cfg):
            calls.append(1)
            raise ValueError('CHATGPT_NOT_FOREGROUND')
        def notifier(req):
            closed.append(True)
            return req['action']
        result = check.dispatch(event, self.cfg, self.runtime, desktop_factory=factory, notifier=notifier, authority=authority)
        self.assertEqual(result['stage'], 'SUPPRESSED')
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.f.store.state(OUT)['manual'], 'SUPPRESSED')

    @mock.patch.object(check, 'NOTIFICATION_FALLBACK_ENABLED', True)
    def test_initial_busy_snapshot_button_and_duplicate_are_once(self):
        p = self.prepare()
        event = self.commit(p['idempotencyKey'])
        desk = Desktop()
        calls = []
        posted = []
        def factory(cfg):
            cfg['windowId'] = 'w-1'
            calls.append(1)
            if len(calls) == 1:
                busy = Desktop()
                original = busy.snapshot
                def snapshot():
                    view = original()
                    tree = view['data']['tree']['children'][0]['children']
                    tree[:] = [item for item in tree if item.get('name') != '发送']
                    tree.append({'role': 'button', 'name': '停止'})
                    return view
                busy.snapshot = snapshot
                return busy
            return desk
        def notifier(req):
            posted.append(req)
            return req['action']
        a = check.dispatch(event, self.cfg, self.runtime, desktop_factory=factory, notifier=notifier, authority=lambda: None)
        b = check.dispatch(event, self.cfg, self.runtime, desktop_factory=factory, notifier=notifier, authority=lambda: None)
        self.assertEqual(a, b)
        self.assertEqual(a['stage'], 'OBSERVED')
        self.assertEqual(len(posted), 1)
        self.assertEqual(len(calls), 2)
        self.assertEqual(desk.sends, 1)

    def test_ordinary_key_does_not_depend_on_optional_native_guard_config(self):
        event = self.commit('ordinary-result')
        self.f.private(self.sidecar, {'invalid': True})
        self.assertIsNone(check.dispatch(event, self.cfg, self.runtime))

    def test_task_label_change_cannot_create_a_second_intent(self):
        self.prepare()
        with mock.patch.object(check.auto_wake, 'resolve_runtime', return_value=self.runtime), \
             mock.patch.object(check.receipt_target, 'inbound_claim', return_value=self.claim):
            with self.assertRaisesRegex(ValueError, 'CHECK_ONLY_REQUEST_CONFLICT'):
                check.prepare(REQUEST, 'different-label', self.cfg)

    def test_worker_routes_only_prepared_check_before_strict_business_guard(self):
        event = {'messageId': OUT, 'sender': {'endpointId': SCOPE['from']}, 'recipient': {'endpointId': SCOPE['to']}}
        Path(self.cfg['stateDir']).mkdir(mode=0o700, exist_ok=True)
        auto_wake.wake.write_state(Path(self.cfg['stateDir']) / (OUT + '.json'), {'stage': 'ADMITTED', 'event': event})
        with mock.patch.object(auto_wake, 'validate_current'), \
             mock.patch.object(check, 'dispatch', return_value={'stage': 'OBSERVED', 'deliveryMode': 'CHECK_ONLY'}) as dispatch:
            r = auto_wake.work(OUT, self.cfg, resolve=lambda cfg: self.runtime,
                               attempt=lambda *args: self.fail('business wake called'),
                               fallback=lambda *args: self.fail('business fallback called'))
        self.assertEqual(r['stage'], 'OBSERVED')
        dispatch.assert_called_once()


if __name__ == '__main__':
    unittest.main()
