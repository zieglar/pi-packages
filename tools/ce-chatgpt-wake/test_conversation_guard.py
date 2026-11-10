"""No real CE/GUI effects: verify the guard and the exact authorized tool boundary."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import test_wake

spec = importlib.util.spec_from_file_location('conversation_guard', Path(__file__).with_name('conversation_guard.py'))
assert spec and spec.loader
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class ConversationGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name)
        self.selection = {'kind': 'HUMAN_SELECTED_REPLY', 'selectionId': 'selection-1',
                          'messageId': 'msg_01M6TS1JHZHZ5DQCNY80RM19G1',
                          'originalRequestMessageId': 'msg_01M6TS0J16K0T4VE04FTFY4QCC',
                          'exchangeId': 'ho_01M5J6YA0EPHAF84QYMKKT7P0B', 'taskId': 'operator-task-1'}

    def test_modes_are_closed_and_do_not_accept_body_source_claims(self):
        for value in (None, {}, {'mode': 'on'}, {'mode': 'title-match', 'sourceTitle': 'A'}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                guard.validate_config(value)
        for mode in ('explicit-only', 'title-match'):
            self.assertEqual(guard.validate_config({'mode': mode}), {'mode': mode})

    def test_neither_mode_can_manufacture_a_source_binding(self):
        self.assertEqual(guard.automatic_decision('explicit-only')['reason'], 'EXPLICIT_ONLY')
        self.assertEqual(guard.automatic_decision('title-match')['reason'], 'SOURCE_BINDING_UNAVAILABLE')

    def test_advisory_title_same_other_renamed_missing_and_whitespace(self):
        windows = [{'id': 'w-1', 'title': 'ChatGPT'}]
        self.assertEqual(guard.check_title('A', windows, test_wake.snapshot(title='A')), 'MATCH')
        for title in ('B', 'renamed-A', '', 'A '):
            with self.subTest(title=title):
                self.assertNotEqual(guard.check_title('A', windows, test_wake.snapshot(title=title)), 'MATCH')
        self.assertEqual(guard.check_title(None, windows, test_wake.snapshot(title='A')), 'SOURCE_TITLE_MISSING')

    def test_duplicate_ambiguous_partial_and_wrong_window_are_unknown(self):
        windows = [{'id': 'w-1', 'title': 'A'}, {'id': 'w-2', 'title': 'A'}]
        self.assertEqual(guard.check_title('A', windows, test_wake.snapshot(title='A')), 'WINDOW_AMBIGUOUS')
        value = test_wake.snapshot(title='A')
        value['data']['tree']['children'].append(dict(value['data']['tree']['children'][0]))
        self.assertEqual(guard.check_title('A', windows[:1], value), 'TITLE_AMBIGUOUS')
        value = test_wake.snapshot(title='A')
        value['data']['complete'] = False
        self.assertEqual(guard.check_title('A', windows[:1], value), 'SNAPSHOT_DENIED')
        self.assertEqual(guard.check_title('A', [{'id': 'other'}], test_wake.snapshot(title='A')), 'WINDOW_CHANGED')

    def test_switch_before_submit_is_detected_by_a_fresh_advisory_check(self):
        windows = [{'id': 'w-1', 'title': 'ChatGPT'}]
        self.assertEqual(guard.check_title('A', windows, test_wake.snapshot(title='A')), 'MATCH')
        self.assertEqual(guard.check_title('A', windows, test_wake.snapshot(title='B')), 'TITLE_MISMATCH')
        # A title MATCH is advisory and never permits an automated attempt by itself.
        self.assertEqual(guard.automatic_decision('title-match')['reason'], 'SOURCE_BINDING_UNAVAILABLE')

    def test_manual_fetch_calls_only_selected_payload_tool_and_preserves_provenance(self):
        calls = []
        def execute(name, args):
            journal = json.loads(next(self.state.glob('fetch-*.json')).read_text())
            self.assertEqual(journal['state'], 'READ_MAY_HAVE_OCCURRED')
            calls.append((name, args))
            return {'content': 'private payload'}
        result = guard.explicit_fetch(self.selection, self.state, execute)
        self.assertEqual(result['state'], 'READ_RETURNED')
        self.assertEqual(result['toolResult'], {'content': 'private payload'})
        self.assertEqual(calls, [('ce_read_payload', {'messageId': self.selection['messageId']})])
        saved = json.loads(next(self.state.glob('fetch-*.json')).read_text())
        self.assertEqual(saved['selection'], self.selection)
        self.assertEqual(saved['provenance'], 'HUMAN_SELECTION_NOT_SOURCE_ATTESTATION')
        self.assertNotIn('private payload', json.dumps(saved))
        again = guard.explicit_fetch(self.selection, self.state, lambda *_: self.fail('duplicate read'))
        self.assertEqual(again['state'], 'READ_RETURNED')
        self.assertNotIn('toolResult', again)

    def test_unknown_manual_outcome_never_retries_and_ack_is_never_called(self):
        execute = mock.Mock(side_effect=OSError('unknown'))
        with self.assertRaisesRegex(ValueError, 'FETCH_OUTCOME_UNKNOWN'):
            guard.explicit_fetch(self.selection, self.state, execute)
        again = guard.explicit_fetch(self.selection, self.state, execute)
        self.assertEqual(again['state'], 'UNKNOWN')
        execute.assert_called_once_with('ce_read_payload', {'messageId': self.selection['messageId']})

    def test_tool_refusal_is_not_recorded_as_success(self):
        result = guard.explicit_fetch(self.selection, self.state, lambda *_: {'isError': True})
        self.assertEqual(result['state'], 'READ_REFUSED')

    def test_missing_mapping_and_changed_task_or_reply_correlation_refused(self):
        execute = mock.Mock()
        for field in ('taskId', 'originalRequestMessageId', 'exchangeId', 'kind'):
            invalid = dict(self.selection)
            invalid.pop(field)
            with self.subTest(field=field), self.assertRaises(ValueError):
                guard.explicit_fetch(invalid, self.state, execute)
        execute.assert_not_called()
        guard.explicit_fetch(self.selection, self.state, lambda *_: 'done')
        for field, value in (('taskId', 'another-task'), ('originalRequestMessageId', 'msg_' + '0' * 26),
                             ('exchangeId', 'ho_' + '0' * 26)):
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'FETCH_MAPPING_CONFLICT'):
                guard.explicit_fetch(dict(self.selection, **{field: value}), self.state, execute)
        execute.assert_not_called()

    def test_each_reply_is_read_by_exact_id_with_its_own_human_selection(self):
        execute = mock.Mock(return_value='selected payload')
        second = dict(self.selection, selectionId='selection-2', messageId='msg_' + '7' * 26)
        guard.explicit_fetch(self.selection, self.state, execute)
        guard.explicit_fetch(second, self.state, execute)
        self.assertEqual(execute.call_args_list, [
            mock.call('ce_read_payload', {'messageId': self.selection['messageId']}),
            mock.call('ce_read_payload', {'messageId': second['messageId']})])
        self.assertEqual(len(list(self.state.glob('fetch-*.json'))), 2)

    def test_interrupt_before_return_preserves_unknown_read_and_does_not_repeat(self):
        execute = mock.Mock(side_effect=KeyboardInterrupt())
        with self.assertRaises(KeyboardInterrupt):
            guard.explicit_fetch(self.selection, self.state, execute)
        self.assertEqual(guard.explicit_fetch(self.selection, self.state, execute)['state'],
                         'READ_MAY_HAVE_OCCURRED')
        execute.assert_called_once()

    def test_symlink_journal_is_refused_without_reading_or_tool_call(self):
        outside = self.state / 'untouched'
        outside.write_text('unchanged')
        (self.state / ('fetch-' + self.selection['messageId'] + '.json')).symlink_to(outside)
        execute = mock.Mock()
        with self.assertRaises((ValueError, OSError)):
            guard.explicit_fetch(self.selection, self.state, execute)
        execute.assert_not_called()
        self.assertEqual(outside.read_text(), 'unchanged')


if __name__ == '__main__':
    unittest.main()
