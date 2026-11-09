import json
from unittest import mock
import unittest

import test_ownership_feedback as fixtures
from test_ownership_guard import REQUEST, OUT, IN
from test_wake import Desktop


class CheckFeedbackTests(unittest.TestCase):
    def setUp(self):
        self.f = fixtures.FeedbackBridgeTests()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)

    def owner_unverified(self):
        p = {**self.f.projection, 'ownerStatus': 'UNVERIFIED', 'projectLabel': None, 'taskOwner': None}
        self.f.store.write(self.f.store.root / 'metadata' / (OUT + '.json'), p)

    def test_associated_unverified_owner_feedback_is_terminal_without_business_or_gui(self):
        self.owner_unverified()
        self.f.body['outcome'] = 'UNVERIFIED'
        self.f.insert('ce-owner-feedback:' + self.f.projection['probeId'] + ':UNVERIFIED')
        self.assertEqual(self.f.classify()['kind'], 'FEEDBACK')
        with mock.patch.object(self.f.store, 'fetch', side_effect=AssertionError('payload path')), \
             mock.patch.object(fixtures.ownership_loop, 'receive_feedback', side_effect=AssertionError('GUI path')):
            result = self.f.consume()
        self.assertEqual(result['kind'], 'TERMINAL')
        self.assertEqual(result['outcome'], 'UNVERIFIED')
        self.assertTrue(result['suppressOrdinaryReply'])
        self.assertTrue((self.f.store.root / 'terminal' / (IN + '.json')).exists())
        self.assertFalse(self.f.store.state(OUT)['notificationEligible'])

    def test_missing_owner_cannot_be_upgraded_by_match_self_claim(self):
        self.owner_unverified()
        self.f.body['outcome'] = 'MATCH'
        self.f.insert('ce-owner-feedback:' + self.f.projection['probeId'] + ':MATCH')
        result = self.f.consume()
        self.assertEqual(result['outcome'], 'UNVERIFIED')
        self.assertEqual(result['status'], 'UNVERIFIED')

    def test_conflict_does_not_turn_a_correlated_control_into_ordinary_business(self):
        p = {**self.f.projection, 'ownerStatus': 'CONFLICT', 'projectLabel': None, 'taskOwner': None}
        self.f.store.write(self.f.store.root / 'metadata' / (OUT + '.json'), p)
        self.assertEqual(self.f.classify()['kind'], 'FEEDBACK')
        self.assertEqual(self.f.consume()['kind'], 'TERMINAL')

    def committed_outgoing(self, key):
        scope = fixtures.SCOPE
        self.f.db.execute('INSERT INTO message VALUES(?,?,?,?,?,?,?,?)',
                          (OUT, scope['exchangeId'], json.dumps({'adapter': 'pi', 'endpointId': scope['from']}),
                           json.dumps({'adapter': 'chatgpt', 'endpointId': scope['to']}), '0' * 64, 1,
                           '2026-11-08T06:00:00Z', key))
        self.f.db.execute('INSERT INTO audit_event VALUES(?,?,?,?)', (200, scope['exchangeId'], 'message_created', OUT))
        self.f.db.commit()

    def ownership_mode(self):
        self.f.cfg['conversationGuard'] = {'mode': 'ownership-check', 'registryDirectory': str(self.f.store.root),
                                           'captureAfterAuditSequence': 100}
        self.f.private(self.f.config_path, self.f.cfg)

    def test_check_only_feedback_never_arms_business_button_in_ownership_mode(self):
        self.committed_outgoing('ce-check-only:' + 'f' * 64)
        self.ownership_mode()
        self.f.store.attempt(OUT, {'windowId': 'w-1'}, Desktop(), metadata_only=True)
        with mock.patch.object(fixtures.ownership_loop, 'receive_feedback', side_effect=AssertionError('business callback')):
            for _ in range(2):
                result = self.f.consume()
                self.assertEqual(result['kind'], 'TERMINAL')
        state = self.f.store.notify(OUT, {}, {}, notifier=lambda req: self.fail('business button offered'))
        self.assertFalse(state['notificationEligible'])
        self.assertEqual(state['notification'], 'NOT_ATTEMPTED')

    def test_actual_ordinary_business_feedback_keeps_existing_explicit_mode_route(self):
        self.committed_outgoing('ordinary-business-reply')
        self.ownership_mode()
        with mock.patch.object(fixtures.ownership_loop, 'receive_feedback', return_value={}) as existing:
            self.assertEqual(self.f.consume()['kind'], 'TERMINAL')
        existing.assert_called_once()

    def test_input_unknown_records_phase_without_recording_any_draft(self):
        desk = Desktop()
        def unknown(ref, text):
            raise TimeoutError('PRIVATE_INPUT_SENTINEL')
        desk.fill = unknown
        result = self.f.store.attempt(OUT, {'windowId': 'w-1'}, desk)
        state = self.f.store.state(OUT)
        self.assertEqual(result['noticeSubmission'], 'UNKNOWN')
        self.assertEqual(state['automaticPhase'], 'INPUT_MAY_HAVE_OCCURRED')
        self.assertNotIn('PRIVATE_INPUT_SENTINEL', json.dumps(state))

    def test_manual_consent_cannot_retry_unknown_automatic_input(self):
        state = self.f.store.state(OUT)
        state.update(automatic='UNKNOWN', manual='CONSENT_CONSUMED')
        self.f.store.save(OUT, state)
        desk = Desktop()
        result = self.f.store.attempt(OUT, {'windowId': 'w-1'}, desk, manual=True)
        self.assertEqual(result['noticeSubmission'], 'NOT_ATTEMPTED')
        self.assertEqual(desk.sends, 0)

    def test_submit_unknown_records_phase_and_never_claims_observed(self):
        desk = Desktop()
        desk.unknown = True
        self.f.store.attempt(OUT, {'windowId': 'w-1'}, desk)
        state = self.f.store.state(OUT)
        self.assertEqual(state['automaticPhase'], 'SUBMIT_MAY_HAVE_OCCURRED')
        self.assertEqual(state['automatic'], 'UNKNOWN')


if __name__ == '__main__':
    unittest.main()
