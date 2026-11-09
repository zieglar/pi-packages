from pathlib import Path
import tempfile
import unittest
from unittest import mock

import ownership_guard as guard
import ownership_loop as loop
from test_ownership_guard import REQUEST, OUT, IN, SCOPE
from test_wake import Desktop


class TerminalFeedbackTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'registry'
        self.store = guard.Store(self.root, SCOPE)
        self.store.register(REQUEST, 'synthetic-project', 'synthetic-owner', confirmation='EXPLICIT_USER')
        self.p = self.store.associate(REQUEST, {'messageId': OUT, 'disposition': 'CREATED', **SCOPE})
        self.cfg = {'windowId': 'w-1', 'maxWaitSeconds': 1}
        self.config = {'conversationGuard': {'mode': 'ownership-check', 'registryDirectory': str(self.root),
                                            'captureAfterAuditSequence': 200}}
        self.runtime = {'hookExchangeId': SCOPE['exchangeId'], 'hookSenderEndpointId': SCOPE['from'],
                        'hookRecipientEndpointId': SCOPE['to']}

    def feedback(self, incoming_id, outcome):
        envelope = {'messageId': incoming_id, 'exchangeId': SCOPE['exchangeId'], 'from': SCOPE['to'], 'to': SCOPE['from']}
        body = {key: self.p[key] for key in ('messageId', 'requestMessageId', 'probeId')}
        body.update(protocol='ce.task-owner-feedback.v1', outcome=outcome)
        return self.store.feedback(envelope, body)

    def assert_terminal(self, incoming_id):
        with mock.patch.object(loop.receipt_target, 'inbound_claim', return_value={'auditSequence': 205}), \
             mock.patch.object(loop, 'key_metadata', return_value=None):
            with self.assertRaisesRegex(ValueError, 'CONTROL_FEEDBACK_IS_TERMINAL'):
                loop.prepare(incoming_id, 'must-not-create-' + incoming_id, self.config, self.runtime)

    def test_manual_match_feedback_new_id_is_terminal_too(self):
        self.store.attempt(OUT, self.cfg, Desktop())
        self.feedback(IN, 'WRONG_CONVERSATION')
        self.store.notify(OUT, self.cfg, {'terminalNotifier': '/synthetic', 'timeoutSeconds': 1,
                          'actionTitle': '检查当前对话'}, notifier=lambda req: req['action'], desktop_factory=Desktop)
        second = 'msg_' + 'F' * 26
        self.feedback(second, 'MATCH')
        self.assert_terminal(IN)
        self.assert_terminal(second)
        self.assertEqual(self.store.state(OUT)['feedback'], 'WRONG_CONVERSATION')
        self.assertEqual(self.store.state(OUT)['manual'], 'OBSERVED')
        self.assertFalse(self.store.state(OUT)['notificationEligible'])

    def test_every_duplicate_or_reordered_feedback_id_is_terminal_after_restart(self):
        ids = ['msg_' + c * 26 for c in ('C', 'F', 'G')]
        for incoming_id, outcome in zip(ids, ('UNVERIFIED', 'WRONG_CONVERSATION', 'MATCH')):
            self.feedback(incoming_id, outcome)
        self.feedback(ids[-1], 'MATCH')
        self.store = guard.Store(self.root, SCOPE)
        for incoming_id in ids:
            self.assert_terminal(incoming_id)
        self.assertFalse(self.store.state(OUT)['notificationEligible'])
        self.assertEqual(self.store.attempt(OUT, self.cfg, Desktop())['noticeSubmission'], 'NOT_ATTEMPTED')


if __name__ == '__main__':
    unittest.main()
