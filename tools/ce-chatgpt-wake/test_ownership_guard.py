import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import ownership_guard as guard
from test_wake import Desktop, snapshot

REQUEST = 'msg_' + 'A' * 26
OUT = 'msg_' + 'B' * 26
IN = 'msg_' + 'C' * 26
SCOPE = {'exchangeId': 'ho_' + 'D' * 26, 'from': 'pi/synthetic', 'to': 'chatgpt/main'}


class OwnershipTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = guard.Store(Path(self.tmp.name) / 'registry', SCOPE)
        self.config = {'windowId': 'w-1', 'pid': 7, 'processInstance': 'synthetic-instance',
                       'maxWaitSeconds': 1}

    def associate(self, registered=True):
        if registered:
            self.store.register(REQUEST, 'synthetic-project', 'synthetic-owner', confirmation='EXPLICIT_USER')
        return self.store.associate(REQUEST, {'messageId': OUT, 'disposition': 'CREATED', **SCOPE})

    def feedback(self, projection, outcome='WRONG_CONVERSATION'):
        body = {key: projection[key] for key in ('probeId', 'requestMessageId', 'messageId')}
        body.update(protocol='ce.task-owner-feedback.v1', outcome=outcome)
        envelope = {'messageId': IN, 'exchangeId': SCOPE['exchangeId'], 'from': SCOPE['to'], 'to': SCOPE['from']}
        return envelope, body

    def test_missing_owner_is_unverified_not_inferred_from_task_label(self):
        p = self.associate(False)
        self.assertEqual(p['ownerStatus'], 'UNVERIFIED')
        self.assertIsNone(p['taskOwner'])
        self.assertEqual(guard.decide(p, {'projectLabel': 'synthetic-project', 'taskOwner': 'synthetic-owner',
                                        'confirmation': 'EXPLICIT_USER'}), 'UNVERIFIED')

    def test_registration_requires_explicit_confirmation_and_conflict_fails_closed(self):
        with self.assertRaises(ValueError):
            self.store.register(REQUEST, 'synthetic-project', 'synthetic-owner', confirmation='TITLE_MATCH')
        self.store.register(REQUEST, 'synthetic-project', 'synthetic-owner', confirmation='EXPLICIT_USER')
        self.store.register(REQUEST, 'different', 'synthetic-owner', confirmation='EXPLICIT_USER')
        self.assertEqual(self.associate(False)['ownerStatus'], 'CONFLICT')

    def test_actual_created_send_and_exact_scope_required(self):
        for delta in ({'disposition': 'UNKNOWN'}, {'exchangeId': 'ho_' + 'E' * 26}, {'to': 'chatgpt/other'}, {'payload': 'private'}):
            with self.subTest(delta=delta), self.assertRaises(ValueError):
                self.store.associate(REQUEST, {'messageId': OUT, 'disposition': 'CREATED', **SCOPE, **delta})
        self.assertFalse((self.store.root / 'metadata' / (OUT + '.json')).exists())

    def test_projection_is_private_stable_metadata_only(self):
        p = self.associate()
        self.assertEqual(p, self.associate())
        path = self.store.root / 'metadata' / (OUT + '.json')
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(set(p), {'schemaVersion', 'exchangeId', 'requestMessageId', 'messageId', 'from', 'to',
                                 'projectLabel', 'taskOwner', 'ownerStatus', 'probeId'})

    def test_match_wrong_unknown_and_exact_payload_read(self):
        p = self.associate()
        own = {'projectLabel': 'synthetic-project', 'taskOwner': 'synthetic-owner', 'confirmation': 'EXPLICIT_USER'}
        calls = []
        execute = lambda tool, args: calls.append((tool, args)) or {'text': 'synthetic'}
        self.assertEqual(guard.decide(p, own), 'MATCH')
        self.assertEqual(guard.decide(p, {**own, 'projectLabel': 'wrong'}), 'WRONG_CONVERSATION')
        self.assertEqual(guard.decide(p, {**own, 'confirmation': 'MEMORY'}), 'UNVERIFIED')
        for who in ({}, {**own, 'taskOwner': 'wrong'}):
            self.store.fetch(OUT, who, execute)
        self.assertEqual(calls, [])
        self.store.fetch(OUT, own, execute)
        self.store.fetch(OUT, own, execute)
        self.assertEqual(calls, [('ce_read_payload', {'messageId': OUT})])

    def test_prompt_contains_exact_ids_without_owner_claim_or_business_execution(self):
        p = self.associate()
        text = guard.prompt(p)
        self.assertIn(OUT, text)
        self.assertIn(p['probeId'], text)
        self.assertIn('ce_task_owner', text)
        self.assertNotIn('synthetic-project', text)
        self.assertNotIn('synthetic-owner', text)
        self.assertNotIn('ce_inbox_list', text)
        self.assertNotIn('按真实 Payload 处理', text)
        with self.assertRaises(ValueError):
            guard.prompt({**p, 'text': 'private'})

    def test_feedback_before_attempt_is_terminal_without_notification(self):
        p = self.associate()
        envelope, body = self.feedback(p)
        result = self.store.feedback(envelope, body)
        self.assertTrue(result['suppressOrdinaryReply'])
        self.assertFalse(result['notificationEligible'])
        self.assertEqual(self.store.attempt(OUT, self.config, Desktop())['noticeSubmission'], 'NOT_ATTEMPTED')

    def test_wrong_feedback_is_one_notification_and_duplicates_do_not_rearm(self):
        p = self.associate()
        self.store.attempt(OUT, self.config, Desktop())
        envelope, body = self.feedback(p)
        r = self.store.feedback(envelope, body)
        self.assertTrue(r['notificationEligible'])
        posted = []
        def notifier(request):
            posted.append(request)
            return '@ACTIONCLICKED'
        self.store.notify(OUT, self.config, {'terminalNotifier': '/synthetic', 'timeoutSeconds': 1,
                          'actionTitle': '检查当前对话'}, notifier=notifier, desktop_factory=Desktop)
        self.store.feedback(envelope, body)
        self.store.notify(OUT, self.config, {'terminalNotifier': '/synthetic', 'timeoutSeconds': 1,
                          'actionTitle': '检查当前对话'}, notifier=notifier, desktop_factory=Desktop)
        self.assertEqual(len(posted), 1)
        self.assertIn(OUT, posted[0]['group'])
        self.assertEqual(self.store.state(OUT)['manual'], 'NOT_ATTEMPTED')

    def test_wrong_feedback_envelope_nonce_or_scope_never_authorizes(self):
        p = self.associate()
        self.store.attempt(OUT, self.config, Desktop())
        envelope, body = self.feedback(p)
        for e, b in [({**envelope, 'from': 'chatgpt/other'}, body),
                     ({**envelope, 'exchangeId': 'ho_' + 'E' * 26}, body),
                     (envelope, {**body, 'probeId': '00000000-0000-4000-8000-000000000000'}),
                     (envelope, {**body, 'messageId': REQUEST})]:
            with self.subTest(e=e, b=b), self.assertRaises(ValueError):
                self.store.feedback(e, b)
        self.assertIsNone(self.store.state(OUT)['feedback'])

    def test_exact_action_button_consumes_one_manual_metadata_check(self):
        p = self.associate()
        self.store.attempt(OUT, self.config, Desktop())
        self.store.feedback(*self.feedback(p, 'UNVERIFIED'))
        desk = Desktop()
        nc = {'terminalNotifier': '/synthetic', 'timeoutSeconds': 1, 'actionTitle': '检查当前对话'}
        result = self.store.notify(OUT, self.config, nc, notifier=lambda req: req['action'], desktop_factory=lambda: desk)
        self.assertEqual(result['manual'], 'OBSERVED')
        self.assertEqual(desk.sends, 1)
        self.store.feedback(*self.feedback(p, 'WRONG_CONVERSATION'))
        self.store.notify(OUT, self.config, nc, notifier=lambda req: req['action'], desktop_factory=lambda: desk)
        self.assertEqual(desk.sends, 1)

    def test_busy_nonempty_and_changed_process_suppress_before_input(self):
        self.associate()
        desk = Desktop()
        desk.draft = 'private existing draft'
        result = self.store.attempt(OUT, self.config, desk)
        self.assertEqual(result['noticeSubmission'], 'NOT_ATTEMPTED')
        self.assertEqual(desk.draft, 'private existing draft')
        self.assertEqual(desk.sends, 0)
        self.assertNotIn('private existing draft', json.dumps(self.store.state(OUT)))

    def test_input_and_submit_unknown_have_no_retry_or_button_fallback(self):
        p = self.associate()
        desk = Desktop()
        def fill(ref, text):
            desk.draft = text
            raise TimeoutError()
        desk.fill = fill
        result = self.store.attempt(OUT, self.config, desk)
        self.assertEqual(result['noticeSubmission'], 'UNKNOWN')
        self.store.feedback(*self.feedback(p))
        self.assertFalse(self.store.state(OUT)['notificationEligible'])
        second = Desktop()
        self.store.attempt(OUT, self.config, second)
        self.assertEqual(second.sends, 0)

    def test_submission_unknown_feedback_does_not_upgrade_or_retry(self):
        p = self.associate()
        desk = Desktop()
        desk.unknown = True
        self.assertEqual(self.store.attempt(OUT, self.config, desk)['noticeSubmission'], 'UNKNOWN')
        self.store.feedback(*self.feedback(p, 'MATCH'))
        self.assertEqual(self.store.state(OUT)['automatic'], 'UNKNOWN')
        self.assertFalse(self.store.state(OUT)['notificationEligible'])

    def test_symlinked_private_files_are_rejected(self):
        p = self.associate()
        path = self.store.root / 'metadata' / (OUT + '.json')
        target = self.store.root / 'actual.json'
        path.rename(target)
        path.symlink_to(target)
        with self.assertRaises(OSError):
            self.store.projection(OUT)


if __name__ == '__main__':
    unittest.main()
