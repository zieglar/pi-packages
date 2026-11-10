"""Targeted desktop regressions from #185/#190; never runs desktop processes."""
import copy
import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import check_only_desktop as adapter
import ownership_guard as guard
from test_check_only_desktop import snapshot, window
from test_ownership_guard import REQUEST, OUT, SCOPE
from test_wake import Desktop


class Desktop194Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.view = snapshot(disabled=True)
        self.calls = []
        self.enabled = None
        self.value = None
        self.reply_patch = None
        self.authority = mock.Mock()
        cfg = {'stateDir': self.tmp.name, 'agentDesktop': '/usr/bin/true',
               'desktopSession': 'synthetic', 'desktopTmpDir': self.tmp.name, 'checkAuthority': self.authority,
               'windowId': 'window-1', 'pid': 42, 'processInstance': 'instance-1'}
        self.cli = adapter.ForegroundDesktop(cfg)
        process_patcher = mock.patch('subprocess.run', side_effect=AssertionError('REAL_PROCESS_FORBIDDEN'))
        process_patcher.start()
        self.addCleanup(process_patcher.stop)
        patcher = mock.patch.object(adapter.wake.ChatGptCli, 'call', lambda cli, args: self.call(args))
        patcher.start()
        self.addCleanup(patcher.stop)

    def call(self, args):
        self.calls.append(args)
        if args[0] == 'list-windows':
            return {'data': [window()]}
        if args[0] == 'snapshot':
            return copy.deepcopy(self.view)
        if args[0] in ('get', 'is'):
            prop = args[-1]
            data = {'ref': args[1], 'property': prop}
            if prop == 'value':
                data['value'] = self.value if self.value is not None else self.view['data']['tree']['children'][0].get('value')
            else:
                enabled = self.enabled
                if enabled is None:
                    enabled = 'disabled' not in self.view['data']['tree']['children'][1].get('states', [])
                data.update(applicable=True, result=enabled)
            if self.reply_patch:
                data.update(self.reply_patch)
            return {'data': data}
        if args[0] in ('set-value', 'click'):
            return {'data': {'disposition': {'delivery': 'delivered_unverified'}}}
        self.fail('unexpected command: ' + args[0])

    def fill(self, text='fixed prompt'):
        self.cli.fill('old-input', text)
        self.view = snapshot(text)
        return text

    def mutations(self):
        return [c for c in self.calls if c[0] in ('set-value', 'click', 'press', 'type')]

    def test_real_missing_states_shape_uses_explicit_enabled_once(self):
        text = self.fill()
        del self.view['data']['tree']['children'][1]['states']
        self.enabled = True
        ref = self.cli.prepare_submit(text)
        self.cli.submit(ref)
        self.assertEqual(self.mutations(), [['set-value', 'input-fresh', text], ['click', 'send-fresh']])
        self.assertIn(['is', 'send-fresh', '--property', 'enabled'], self.calls)

    def test_unknown_disabled_and_malformed_enabled_never_click(self):
        text = self.fill()
        for patch in ({'applicable': False, 'result': False}, {'result': False},
                      {'result': 1}, {'applicable': 1}, {'ref': 'other'}, {'property': 'focused'}):
            with self.subTest(patch=patch):
                self.reply_patch = patch
                with self.assertRaises(ValueError):
                    self.cli.prepare_submit(text)
        self.assertFalse(any(c[0] == 'click' for c in self.calls))

    def test_no_trimming_normalization_or_partial_text_acceptance(self):
        text = self.fill('full  prompt\nkeeps spaces ')
        for actual in (text[:-1], text.strip(), text.replace('  ', ' '), text + '\n', text[:6]):
            self.view = snapshot(actual)
            with self.subTest(actual=actual), self.assertRaises(ValueError):
                self.cli.prepare_submit(text)
        self.assertFalse(any(c[0] == 'click' for c in self.calls))

    def test_snapshot_and_get_value_must_agree_in_full(self):
        text = self.fill()
        self.value = text[:-1]
        with self.assertRaises(ValueError):
            self.cli.prepare_submit(text)
        self.assertFalse(any(c[0] == 'click' for c in self.calls))

    def test_missing_or_nonstring_input_is_not_empty(self):
        for value in (None, False, 0, [], {}):
            self.view = snapshot(value, disabled=True)
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.cli.snapshot()
        self.assertEqual(self.mutations(), [])

    def test_observed_placeholder_requires_known_disabled_send(self):
        self.view = snapshot('询问 ChatGPT\n', disabled=False)
        with self.assertRaises(ValueError):
            self.cli.fill('old', 'fixed prompt')
        self.view = snapshot('询问 ChatGPT\n', disabled=True)
        self.cli.fill('old', 'fixed prompt')
        self.assertEqual(len(self.mutations()), 1)

    def test_double_input_and_submit_are_refused_before_second_mutation(self):
        text = self.fill()
        with self.assertRaises(ValueError):
            self.cli.fill('old', text)
        self.cli.submit(self.cli.prepare_submit(text))
        with self.assertRaises(ValueError):
            self.cli.submit('old')
        with self.assertRaises(ValueError):
            self.cli.prepare_submit(text)
        self.assertEqual([c[0] for c in self.mutations()], ['set-value', 'click'])

    def test_lost_command_result_cannot_retry_or_fall_back_to_keyboard(self):
        text = self.fill()
        ref = self.cli.prepare_submit(text)
        original = self.cli.call
        def lost(args):
            if args[0] == 'click':
                self.calls.append(args)
                raise TimeoutError()
            return original(args)
        with mock.patch.object(self.cli, 'call', lost):
            with self.assertRaises(TimeoutError):
                self.cli.submit(ref)
            with self.assertRaises(ValueError):
                self.cli.submit(ref)
        self.assertEqual([c[0] for c in self.mutations()], ['set-value', 'click'])

    def test_action_rechecks_use_latest_refs_instead_of_cached_refs(self):
        ref = self.cli.prepare_fill('fixed prompt')
        self.view = snapshot(input_ref='last-input', send_ref='empty-send')
        self.cli.fill(ref, 'fixed prompt')
        self.view = snapshot('fixed prompt', send_ref='prepared-send')
        ref = self.cli.prepare_submit('fixed prompt')
        self.view = snapshot('fixed prompt', send_ref='last-send')
        self.cli.submit(ref)
        self.assertEqual(self.mutations(), [['set-value', 'last-input', 'fixed prompt'], ['click', 'last-send']])

    def test_raw_empty_string_is_not_verified_empty(self):
        self.view = snapshot('', disabled=True)
        with self.assertRaisesRegex(ValueError, 'VERIFIED_EMPTY_COMPOSER_REQUIRED'):
            self.cli.prepare_fill('fixed prompt')
        self.assertEqual(self.mutations(), [])

    def test_change_after_prepare_never_overwrites_draft(self):
        self.cli.prepare_fill('fixed prompt')
        self.view = snapshot('user draft', disabled=False)
        with self.assertRaisesRegex(ValueError, 'PRE_INPUT_STATE_CHANGED'):
            self.cli.fill('input-fresh', 'fixed prompt')
        self.assertEqual(self.mutations(), [])

    def test_change_after_prepare_never_submits_changed_text(self):
        text = self.fill()
        ref = self.cli.prepare_submit(text)
        self.view = snapshot(text + '\nuser addition')
        with self.assertRaisesRegex(ValueError, 'PRE_SUBMIT_STATE_CHANGED'):
            self.cli.submit(ref)
        self.assertEqual([c[0] for c in self.mutations()], ['set-value'])


    def attempt_cli(self, mode):
        store = guard.Store(Path(self.tmp.name) / 'registry', SCOPE)
        store.associate(REQUEST, {'messageId': OUT, 'disposition': 'CREATED', **SCOPE})
        original = self.cli.call
        def interact(args):
            if (mode, args[0]) in (('owner-input', 'set-value'), ('owner-submit', 'click')):
                self.cli.config['checkRegisteredOwner'] = mock.Mock(
                    side_effect=ValueError('REGISTERED_OWNER_CHANGED'))
            result = original(args)
            if args[0] == 'set-value':
                self.view = snapshot(args[2], disabled=mode == 'disabled')
            if args[0] == 'click':
                text = self.view['data']['tree']['children'][0]['value']
                if mode == 'lost':
                    raise TimeoutError()
                self.view = snapshot('' if mode == 'message' else '\n', disabled=mode == 'message')
                if mode == 'message':
                    self.view['data']['tree']['children'].append({'role': 'statictext', 'value': text})
            return result
        with mock.patch.object(self.cli, 'call', interact):
            result = store.attempt(OUT, self.cli.config, self.cli, metadata_only=True)
            store.attempt(OUT, self.cli.config, self.cli, metadata_only=True)
        return result, store.state(OUT)

    def test_real_adapter_and_store_record_full_integrity_and_single_observed_message(self):
        result, state = self.attempt_cli('message')
        self.assertEqual(result['noticeSubmission'], 'OBSERVED')
        self.assertEqual(state['automaticPhase'], 'NOTICE_OBSERVED')
        text = next(c[2] for c in self.mutations() if c[0] == 'set-value')
        self.assertEqual(state['automaticInputProof'], {
            'length': len(text), 'sha256': hashlib.sha256(text.encode()).hexdigest()})
        self.assertTrue(state['automaticInputAttempted'])
        self.assertTrue(state['automaticSubmitAttempted'])
        self.assertEqual([c[0] for c in self.mutations()], ['set-value', 'click'])

    def test_last_owner_gate_rejects_input_without_attempted_flag(self):
        result, state = self.attempt_cli('owner-input')
        self.assertEqual(result['noticeSubmission'], 'NOT_ATTEMPTED')
        self.assertEqual((state['automatic'], state['automaticPhase']), ('SUPPRESSED', 'OBSERVING'))
        self.assertEqual(state['automaticReason'], 'REGISTERED_OWNER_CHANGED')
        self.assertFalse(state['automaticInputAttempted'])
        self.assertFalse(state['automaticSubmitAttempted'])
        self.assertEqual(self.mutations(), [])

    def test_last_owner_gate_rejects_submit_without_attempted_flag(self):
        result, state = self.attempt_cli('owner-submit')
        self.assertEqual(result['noticeSubmission'], 'UNKNOWN')
        self.assertEqual(state['automaticPhase'], 'INPUT_MAY_HAVE_OCCURRED')
        self.assertEqual(state['automaticReason'], 'REGISTERED_OWNER_CHANGED')
        self.assertTrue(state['automaticInputAttempted'])
        self.assertFalse(state['automaticSubmitAttempted'])
        self.assertEqual([c[0] for c in self.mutations()], ['set-value'])

    def test_real_adapter_disabled_before_click_records_known_no_submit(self):
        result, state = self.attempt_cli('disabled')
        self.assertEqual(result['noticeSubmission'], 'UNKNOWN')
        self.assertEqual(state['automaticPhase'], 'INPUT_MAY_HAVE_OCCURRED')
        self.assertEqual(state['automaticReason'], 'SEND_DISABLED')
        self.assertTrue(state['automaticInputAttempted'])
        self.assertFalse(state['automaticSubmitAttempted'])
        self.assertEqual([c[0] for c in self.mutations()], ['set-value'])

    def test_unverified_semantic_click_that_only_adds_newline_stays_unknown(self):
        result, state = self.attempt_cli('newline')
        self.assertEqual(result['noticeSubmission'], 'UNKNOWN')
        self.assertEqual(state['automaticReason'], 'SUBMISSION_UNVERIFIED')
        self.assertEqual(state['automaticPhase'], 'SUBMIT_MAY_HAVE_OCCURRED')
        self.assertEqual([c[0] for c in self.mutations()], ['set-value', 'click'])

    def test_lost_real_adapter_click_stays_unknown_and_never_retries(self):
        result, state = self.attempt_cli('lost')
        self.assertEqual(result['noticeSubmission'], 'UNKNOWN')
        self.assertEqual(state['automaticReason'], 'TimeoutError')
        self.assertTrue(state['automaticSubmitAttempted'])
        self.assertEqual([c[0] for c in self.mutations()], ['set-value', 'click'])



class Attempt194Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = guard.Store(Path(self.tmp.name) / 'registry', SCOPE)
        self.projection = self.store.associate(REQUEST, {'messageId': OUT, 'disposition': 'CREATED', **SCOPE})
        self.cfg = {'windowId': 'w-1', 'pid': 7, 'processInstance': 'synthetic-instance', 'maxWaitSeconds': 1}

    def run_attempt(self, desktop):
        return self.store.attempt(OUT, self.cfg, desktop, metadata_only=True)

    def test_preinput_validation_failure_has_no_input_marker(self):
        desktop = Desktop()
        desktop.prepare_fill = mock.Mock(side_effect=ValueError('EDITOR_VALUE_UNKNOWN'))
        self.run_attempt(desktop)
        state = self.store.state(OUT)
        self.assertEqual((state['automatic'], state['automaticPhase']), ('SUPPRESSED', 'OBSERVING'))
        self.assertEqual(desktop.draft, '')
        self.assertEqual(desktop.sends, 0)

    def test_presubmit_validation_failure_stays_after_input_before_submit(self):
        desktop = Desktop()
        desktop.prepare_submit = mock.Mock(side_effect=ValueError('SEND_ENABLED_UNKNOWN'))
        self.run_attempt(desktop)
        state = self.store.state(OUT)
        self.assertEqual((state['automatic'], state['automaticPhase']), ('UNKNOWN', 'INPUT_MAY_HAVE_OCCURRED'))
        self.assertEqual(state['automaticReason'], 'SEND_ENABLED_UNKNOWN')
        self.assertEqual(desktop.sends, 0)
        self.run_attempt(desktop)
        self.assertEqual(desktop.sends, 0)

    def test_newline_only_postsubmit_and_uncertain_click_remain_unknown_once(self):
        desktop = Desktop()
        def newline(ref):
            desktop.sends += 1
            desktop.draft += '\n'
        desktop.submit = newline
        self.run_attempt(desktop)
        state = self.store.state(OUT)
        self.assertEqual((state['automatic'], state['automaticPhase']), ('UNKNOWN', 'SUBMIT_MAY_HAVE_OCCURRED'))
        self.assertEqual(state['automaticReason'], 'SUBMISSION_UNVERIFIED')
        self.run_attempt(desktop)
        self.assertEqual(desktop.sends, 1)

    def test_shorter_singleline_metadata_prompt_preserves_contract(self):
        text = guard.prompt(self.projection, metadata_only=True)
        self.assertLess(len(text), 900)
        self.assertNotIn('\n', text)
        for field in ('ce_task_owner', 'ce_send', 'ce.task-owner-feedback.v1', 'ce-owner-feedback:',
                      'UNVERIFIED', 'WRONG_CONVERSATION', 'REGISTERED', 'MATCH', 'ce_read_payload',
                      'Inbox', 'ACK', self.projection['probeId'], OUT, REQUEST, SCOPE['from']):
            self.assertIn(field, text)
        self.assertIn('不重试', text)


if __name__ == '__main__':
    unittest.main()
