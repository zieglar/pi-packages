import copy
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import conversation_guard
import ownership_guard
import ownership_loop as loop
from test_ownership_guard import REQUEST, OUT, IN, SCOPE
from test_wake import Desktop, snapshot


class LoopTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.config = {'stateDir': self.tmp.name, 'maxWaitSeconds': 2, 'agentDesktop': '/synthetic',
                       'terminalNotifier': '/synthetic', 'notificationTimeoutSeconds': 2,
                       'conversationGuard': {'mode': 'ownership-check', 'registryDirectory': self.tmp.name + '/ownership',
                                             'captureAfterAuditSequence': 200}}
        self.runtime = {'hookExchangeId': SCOPE['exchangeId'], 'hookSenderEndpointId': SCOPE['from'],
                        'hookRecipientEndpointId': SCOPE['to'], 'databasePath': '/nonexistent'}
        self.event = {'messageId': OUT, 'exchangeId': SCOPE['exchangeId'],
                      'sender': {'adapter': 'pi', 'endpointId': SCOPE['from']},
                      'recipient': {'adapter': 'chatgpt', 'endpointId': SCOPE['to']}}

    def test_explicit_only_cannot_enter_metadata_action_path(self):
        cfg = {**self.config, 'conversationGuard': {'mode': 'explicit-only'}}
        with self.assertRaisesRegex(ValueError, 'OWNERSHIP_MODE_REQUIRED'):
            loop.store_for(cfg, self.runtime)

    def test_new_mode_is_visible_strict_config_not_an_explicit_only_sideflag(self):
        self.assertEqual(conversation_guard.validate_config(self.config['conversationGuard']), self.config['conversationGuard'])
        for value in ({'mode': 'ownership-check'}, {**self.config['conversationGuard'], 'enabled': True},
                      {**self.config['conversationGuard'], 'registryDirectory': 'relative'}):
            with self.assertRaises(ValueError):
                conversation_guard.validate_config(value)

    def test_prepare_requires_native_received_request_and_uncommitted_key(self):
        with mock.patch.object(loop.receipt_target, 'inbound_claim', side_effect=ValueError('REQUEST_NOT_RECEIVED')):
            with self.assertRaisesRegex(ValueError, 'REQUEST_NOT_RECEIVED'):
                loop.prepare(REQUEST, 'synthetic-key', self.config, self.runtime)
        with mock.patch.object(loop.receipt_target, 'inbound_claim', return_value={'auditSequence': 201}), \
             mock.patch.object(loop, 'key_metadata', return_value={'messageId': OUT, 'auditSequence': 202}):
            with self.assertRaisesRegex(ValueError, 'REPLY_ALREADY_COMMITTED'):
                loop.prepare(REQUEST, 'synthetic-key', self.config, self.runtime)

    def test_hook_maps_only_prepared_future_key_and_missing_owner_suppresses_gui(self):
        with mock.patch.object(loop.receipt_target, 'inbound_claim', return_value={'auditSequence': 201}), \
             mock.patch.object(loop, 'key_metadata', return_value=None):
            loop.prepare(REQUEST, 'synthetic-key', self.config, self.runtime)
        metadata = {'idempotencyKey': 'synthetic-key', 'messageId': OUT, 'auditSequence': 202}
        desk = mock.Mock()
        with mock.patch.object(loop, 'outgoing_metadata', return_value=metadata):
            r = loop.outgoing(self.event, self.config, self.runtime, desktop_factory=lambda cfg: desk)
        self.assertEqual(r['stage'], 'SUPPRESSED')
        self.assertEqual(r['reason'], 'OWNER_UNVERIFIED')
        desk.assert_not_called()

    def test_observed_auto_probe_does_not_notify_until_correlated_wrong_feedback(self):
        with mock.patch.object(loop.receipt_target, 'inbound_claim', return_value={'auditSequence': 201}), \
             mock.patch.object(loop, 'key_metadata', return_value=None):
            loop.prepare(REQUEST, 'synthetic-key', self.config, self.runtime)
        store = loop.store_for(self.config, self.runtime)
        store.register(REQUEST, 'synthetic-project', 'synthetic-owner', confirmation='EXPLICIT_USER')
        metadata = {'idempotencyKey': 'synthetic-key', 'messageId': OUT, 'auditSequence': 202}
        def factory(cfg):
            cfg.update(windowId='w-1')
            return Desktop()
        with mock.patch.object(loop, 'outgoing_metadata', return_value=metadata), \
             mock.patch.object(loop, 'current_authority') as authority:
            r = loop.outgoing(self.event, self.config, self.runtime, desktop_factory=factory)
        self.assertEqual(r['stage'], 'OBSERVED')
        self.assertEqual(store.state(OUT)['notification'], 'NOT_ATTEMPTED')
        self.assertGreaterEqual(authority.call_count, 3)

    def test_unprepared_outgoing_has_no_wake_or_reply_loop(self):
        with mock.patch.object(loop, 'outgoing_metadata', return_value={'idempotencyKey': 'ordinary-result',
                              'messageId': OUT, 'auditSequence': 202}):
            r = loop.outgoing(self.event, self.config, self.runtime, desktop_factory=lambda cfg: self.fail('GUI called'))
        self.assertEqual(r['stage'], 'SUPPRESSED')
        self.assertEqual(r['reason'], 'UNPREPARED_OWNERSHIP_REPLY')

    def test_current_desktop_rechecks_unique_window_and_same_process(self):
        cfg = {'executionEnd': 999999999999, 'windowId': 'w-1', 'pid': 1, 'processInstance': 'instance'}
        cli = object.__new__(loop.CurrentDesktop)
        cli.config = cfg
        cli.call = mock.Mock(return_value={'data': [{'id': 'w-1', 'pid': 1, 'process_instance': 'instance'},
                                                   {'id': 'w-2', 'pid': 1, 'process_instance': 'instance'}]})
        with self.assertRaisesRegex(ValueError, 'UNIQUE_CHATGPT_WINDOW_REQUIRED'):
            cli.snapshot()
        cli.call.return_value = {'data': [{'id': 'w-1', 'pid': 2, 'process_instance': 'new'}]}
        with self.assertRaisesRegex(ValueError, 'CHATGPT_PROCESS_OR_WINDOW_CHANGED'):
            cli.snapshot()

    def test_busy_and_readback_mismatch_never_call_submit(self):
        store = loop.store_for(self.config, self.runtime)
        store.register(REQUEST, 'synthetic-project', 'synthetic-owner', confirmation='EXPLICIT_USER')
        store.associate(REQUEST, {'messageId': OUT, 'disposition': 'CREATED', **SCOPE})
        desk = Desktop()
        snap = snapshot()
        snap['data']['tree']['children'][0]['children'].append({'role': 'button', 'name': '停止生成'})
        desk.snapshot = lambda: snap
        r = store.attempt(OUT, {'windowId': 'w-1'}, desk)
        self.assertEqual(r['noticeSubmission'], 'NOT_ATTEMPTED')
        self.assertEqual(desk.sends, 0)


if __name__ == '__main__':
    unittest.main()
