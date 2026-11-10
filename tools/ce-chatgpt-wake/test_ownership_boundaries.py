import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import auto_wake
import ownership_guard as guard
import ownership_loop as loop
import wake
from test_ownership_guard import REQUEST, OUT, IN, SCOPE
from test_wake import Desktop, snapshot


class Boundaries(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = guard.Store(Path(self.tmp.name) / 'registry', SCOPE)
        self.store.register(REQUEST, 'synthetic-project', 'synthetic-owner', confirmation='EXPLICIT_USER')
        self.p = self.store.associate(REQUEST, {'messageId': OUT, 'disposition': 'CREATED', **SCOPE})
        self.cfg = {'windowId': 'w-1', 'maxWaitSeconds': 1}
        self.own = {'projectLabel': 'synthetic-project', 'taskOwner': 'synthetic-owner', 'confirmation': 'EXPLICIT_USER'}
        self.envelope = {'messageId': IN, 'exchangeId': SCOPE['exchangeId'], 'from': SCOPE['to'], 'to': SCOPE['from']}
        self.body = {key: self.p[key] for key in ('messageId', 'requestMessageId', 'probeId')}
        self.body.update(protocol='ce.task-owner-feedback.v1', outcome='WRONG_CONVERSATION')

    def test_payload_tool_refusal_is_unknown_and_never_retried(self):
        calls = []
        def denied(tool, args):
            calls.append((tool, args))
            return {'isError': True, 'content': [{'type': 'text', 'text': 'Denied'}]}
        r = self.store.fetch(OUT, self.own, denied)
        self.assertEqual(r['payloadRead'], 'UNKNOWN')
        self.store.fetch(OUT, self.own, denied)
        self.assertEqual(len(calls), 1)
        self.assertNotIn('Denied', json.dumps(self.store.state(OUT)))

    def test_authority_change_before_input_never_fills(self):
        desk = Desktop()
        result = self.store.attempt(OUT, self.cfg, desk, authority=mock.Mock(side_effect=ValueError('OWNER_CHANGED')))
        self.assertEqual(result['noticeSubmission'], 'NOT_ATTEMPTED')
        self.assertEqual(desk.draft, '')

    def test_authority_change_after_input_is_unknown_and_prevents_submit(self):
        desk = Desktop()
        authority = mock.Mock(side_effect=[None, None, ValueError('OWNER_CHANGED')])
        result = self.store.attempt(OUT, self.cfg, desk, authority=authority)
        self.assertEqual(result['noticeSubmission'], 'UNKNOWN')
        self.assertEqual(desk.sends, 0)
        self.store.feedback(self.envelope, self.body)
        self.assertFalse(self.store.state(OUT)['notificationEligible'])

    def test_submission_missing_exact_prompt_readback_is_unknown(self):
        desk = Desktop()
        def submit(ref):
            desk.sends += 1
            desk.draft = ''
        desk.submit = submit
        self.assertEqual(self.store.attempt(OUT, self.cfg, desk)['noticeSubmission'], 'UNKNOWN')
        self.store.feedback(self.envelope, self.body)
        self.assertFalse(self.store.state(OUT)['notificationEligible'])

    def test_notifier_timeout_close_and_body_click_never_construct_desktop(self):
        for outcome in ('@CLOSED', '@TIMEOUT', '@ACTIONCLICKED', '', None):
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as folder:
                store = guard.Store(Path(folder) / 'registry', SCOPE)
                store.register(REQUEST, 'synthetic-project', 'synthetic-owner', confirmation='EXPLICIT_USER')
                p = store.associate(REQUEST, {'messageId': OUT, 'disposition': 'CREATED', **SCOPE})
                store.attempt(OUT, self.cfg, Desktop())
                body = {**self.body, 'probeId': p['probeId']}
                store.feedback(self.envelope, body)
                factory = mock.Mock(side_effect=AssertionError('Desktop constructed'))
                store.notify(OUT, self.cfg, {'terminalNotifier': '/synthetic', 'timeoutSeconds': 1,
                             'actionTitle': '检查当前对话'}, notifier=lambda req: outcome, desktop_factory=factory)
                factory.assert_not_called()

    def test_conflicting_feedback_is_terminal_and_never_rearms_notification(self):
        self.store.attempt(OUT, self.cfg, Desktop())
        self.store.feedback(self.envelope, self.body)
        self.store.notify(OUT, self.cfg, {'terminalNotifier': '/synthetic', 'timeoutSeconds': 1,
                          'actionTitle': '检查当前对话'}, notifier=lambda req: '@CLOSED', desktop_factory=Desktop)
        self.store.feedback({**self.envelope, 'messageId': 'msg_' + 'F' * 26}, {**self.body, 'outcome': 'MATCH'})
        state = self.store.state(OUT)
        self.assertEqual(state['automatic'], 'OBSERVED')
        self.assertEqual(state['feedback'], 'WRONG_CONVERSATION')
        self.assertFalse(state['notificationEligible'])

    def test_conflicting_registration_revokes_existing_projection(self):
        self.store.register(REQUEST, 'different-project', 'synthetic-owner', confirmation='EXPLICIT_USER')
        self.assertEqual(self.store.projection(OUT)['ownerStatus'], 'CONFLICT')
        self.store.fetch(OUT, self.own, lambda tool, args: self.fail('Payload called'))

    def test_native_feedback_requires_receive_receipt_before_notification(self):
        cfg = {'conversationGuard': {'mode': 'ownership-check', 'registryDirectory': str(self.store.root),
                                    'captureAfterAuditSequence': 200}}
        runtime = {'hookExchangeId': SCOPE['exchangeId'], 'hookSenderEndpointId': SCOPE['from'],
                   'hookRecipientEndpointId': SCOPE['to']}
        with mock.patch.object(loop.receipt_target, 'inbound_claim', side_effect=ValueError('REQUEST_NOT_RECEIVED')):
            with self.assertRaisesRegex(ValueError, 'REQUEST_NOT_RECEIVED'):
                loop.receive_feedback(IN, self.body, cfg, runtime, notifier=lambda req: self.fail('Notification called'))

    def test_hook_ownership_mode_does_not_call_old_business_driver_or_fallback(self):
        cfg = {'stateDir': self.tmp.name, 'conversationGuard': {'mode': 'ownership-check'}}
        event = {'messageId': OUT, 'sender': {'endpointId': SCOPE['from']}, 'recipient': {'endpointId': SCOPE['to']}}
        wake.write_state(Path(self.tmp.name) / (OUT + '.json'), {'stage': 'ADMITTED', 'event': event})
        with mock.patch.object(auto_wake, 'validate_current'), \
             mock.patch('check_only.dispatch', return_value=None), \
             mock.patch.object(loop, 'outgoing', return_value={'stage': 'OBSERVED'}) as run:
            result = auto_wake.work(OUT, cfg, resolve=lambda c: {}, attempt=lambda *a: self.fail('old driver'),
                                    fallback=lambda *a: self.fail('old fallback'))
        self.assertEqual(result['stage'], 'OBSERVED')
        self.assertEqual(run.call_count, 1)
        auto_wake.work(OUT, cfg, resolve=lambda c: self.fail('duplicate'))


if __name__ == '__main__':
    unittest.main()
