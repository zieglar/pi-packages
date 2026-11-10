import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('notification', Path(__file__).with_name('notification.py'))
notification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notification)


class NotificationBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.desktop = self.root / 'desktop.json'
        self.desktop.write_text(json.dumps({'targetEndpoint': 'chatgpt/main', 'replyEndpoint': 'pi/wake-test'}))
        self.config = {
            'terminalNotifier': '/opt/homebrew/bin/terminal-notifier',
            'stateDir': str(self.root / 'state'),
            'desktopConfig': str(self.desktop),
            'actionTitle': '读取 CE 消息',
            'timeoutSeconds': 30,
        }
        self.record = {
            'testId': 'CE-WAKE-TEST-notify-01',
            'messageId': 'msg_01M6D7BPKRDG38PE854761T7MN',
            'to': 'chatgpt/main',
            'replyTo': 'pi/wake-test',
            'disposition': 'CREATED',
        }

    def test_one_task_creates_one_exact_group_and_routes_click_by_task_id(self):
        calls = []
        routed = []
        def notifier(request):
            calls.append(request)
            return '读取 CE 消息'
        result = notification.post(self.record, self.config, notifier=notifier,
                                   handler=lambda task_id, _: routed.append(task_id) or {'state': 'TAKEN_OVER'})
        self.assertEqual(result['state'], 'TAKEN_OVER')
        self.assertEqual(calls[0]['group'], 'ce-chatgpt-wake:' + self.record['testId'])
        self.assertEqual(calls[0]['action'], self.config['actionTitle'])
        self.assertEqual(routed, [self.record['testId']])
        self.assertNotIn(self.record['messageId'], calls[0]['message'])

    def test_attempt_is_durable_before_native_notification_and_repeat_does_not_post(self):
        observed = []
        def notifier(request):
            journal = notification.journal_path(self.config, self.record['testId'])
            observed.append(json.loads(journal.read_text())['state'])
            return '@TIMEOUT'
        first = notification.post(self.record, self.config, notifier=notifier)
        second = notification.post(self.record, self.config, notifier=lambda _: self.fail('reposted'))
        self.assertEqual(observed, ['NOTIFICATION_ATTEMPTED'])
        self.assertEqual(first, second)
        self.assertEqual(first['state'], 'UNKNOWN')

    def test_same_task_id_with_changed_message_is_refused(self):
        notification.post(self.record, self.config, notifier=lambda _: '@TIMEOUT')
        changed = dict(self.record, messageId='msg_' + '7' * 26)
        with self.assertRaisesRegex(ValueError, 'TASK_ID_CONFLICT'):
            notification.post(changed, self.config, notifier=lambda _: '@TIMEOUT')

    def test_unknown_or_closed_notification_does_not_call_handler(self):
        for outcome in ('@TIMEOUT', '@CLOSED'):
            with self.subTest(outcome=outcome):
                config = dict(self.config, stateDir=str(self.root / outcome[1:]))
                handler = mock.Mock()
                result = notification.post(self.record, config, notifier=lambda _: outcome, handler=handler)
                self.assertIn(result['state'], ('UNKNOWN', 'DISMISSED'))
                handler.assert_not_called()

    def test_handler_removes_exact_group_only_after_observed_takeover(self):
        notification.post(self.record, self.config, notifier=lambda _: self.config['actionTitle'],
                          handler=lambda *_: {'state': 'ACTION_CLICKED'})
        removed = []
        observed = notification.handle(self.record['testId'], self.config,
                                       wake=lambda record, _: {'noticeSubmission': 'OBSERVED'},
                                       remover=lambda group: removed.append(group))
        self.assertEqual(observed['state'], 'TAKEN_OVER')
        self.assertEqual(removed, ['ce-chatgpt-wake:' + self.record['testId']])

    def test_handler_preserves_notification_when_takeover_is_unknown(self):
        notification.post(self.record, self.config, notifier=lambda _: self.config['actionTitle'],
                          handler=lambda *_: {'state': 'ACTION_CLICKED'})
        removed = []
        result = notification.handle(self.record['testId'], self.config,
                                     wake=lambda record, _: {'noticeSubmission': 'UNKNOWN'},
                                     remover=removed.append)
        self.assertEqual(result['state'], 'UNKNOWN')
        self.assertEqual(removed, [])

    def test_handler_exact_task_lookup_rejects_unknown_and_corrupt_mapping(self):
        with self.assertRaisesRegex(ValueError, 'TASK_NOT_FOUND'):
            notification.handle('CE-WAKE-TEST-missing', self.config, wake=None, remover=None)
        notification.post(self.record, self.config, notifier=lambda _: '@TIMEOUT')
        path = notification.journal_path(self.config, self.record['testId'])
        saved = json.loads(path.read_text())
        saved['taskId'] = 'CE-WAKE-TEST-other'
        path.write_text(json.dumps(saved))
        with self.assertRaisesRegex(ValueError, 'TASK_MAPPING_INVALID'):
            notification.handle(self.record['testId'], self.config, wake=None, remover=None)

    def test_notification_body_click_is_not_consent(self):
        routed = []
        result = notification.post(self.record, self.config, notifier=lambda _: '@ACTIONCLICKED',
                                   handler=lambda task_id, _: routed.append(task_id) or {'state': 'TAKEN_OVER'})
        self.assertEqual(result['state'], 'UNKNOWN')
        self.assertEqual(routed, [])
        saved = json.loads(notification.journal_path(self.config, self.record['testId']).read_text())
        self.assertNotIn('consent', saved)

    def test_only_the_exact_action_button_is_consent(self):
        for outcome in ('@ACTIONCLICKED', '@CLOSED', '@TIMEOUT', self.config['actionTitle'] + ' '):
            with self.subTest(outcome=outcome):
                config = dict(self.config, stateDir=str(self.root / ('state-' + outcome.strip('@') or 'x')))
                routed = []
                result = notification.post(self.record, config, notifier=lambda _: outcome,
                                           handler=lambda task_id, _: routed.append(task_id) or {'state': 'TAKEN_OVER'})
                self.assertEqual(result['state'], 'DISMISSED' if outcome == '@CLOSED' else 'UNKNOWN')
                self.assertEqual(routed, [])

    def test_explicit_action_button_records_consent_source(self):
        routed = []
        notification.post(self.record, self.config, notifier=lambda _: self.config['actionTitle'],
                          handler=lambda task_id, _: routed.append(task_id) or {'state': 'TAKEN_OVER'})
        saved = json.loads(notification.journal_path(self.config, self.record['testId']).read_text())
        self.assertEqual(saved['consent'], 'ACTION_BUTTON')
        self.assertEqual(routed, [self.record['testId']])

    def test_shared_state_directory_with_the_desktop_driver_is_refused(self):
        desktop = json.loads(self.desktop.read_text())
        desktop['stateDir'] = self.config['stateDir']
        self.desktop.write_text(json.dumps(desktop))
        with self.assertRaisesRegex(ValueError, 'NOTIFICATION_STATE_DIR_CONFLICT'):
            notification.post(self.record, self.config, notifier=lambda _: '@TIMEOUT')

    def test_symlink_or_public_journal_is_never_followed(self):
        state = Path(self.config['stateDir'])
        state.mkdir(mode=0o700)
        target = self.root / 'target.json'
        target.write_text('{}')
        path = notification.journal_path(self.config, self.record['testId'])
        path.symlink_to(target)
        with self.assertRaisesRegex(ValueError, 'TASK_STATE_UNSAFE'):
            notification.post(self.record, self.config, notifier=lambda _: '@TIMEOUT')
        self.assertEqual(target.read_text(), '{}')
        path.unlink()
        path.write_text('{}')
        path.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'TASK_STATE_UNSAFE'):
            notification.handle(self.record['testId'], self.config, wake=None, remover=None)

    def test_direct_handle_requires_real_button_consent(self):
        notification.post(self.record, self.config, notifier=lambda _: '@TIMEOUT')
        wake = mock.Mock(return_value={'noticeSubmission': 'OBSERVED'})
        with self.assertRaisesRegex(ValueError, 'ACTION_CONSENT_REQUIRED'):
            notification.handle(self.record['testId'], self.config, wake=wake)
        wake.assert_not_called()

    def test_button_handler_runs_at_most_once_even_after_unknown(self):
        wake = mock.Mock(return_value={'noticeSubmission': 'UNKNOWN'})
        notification.post(self.record, self.config, notifier=lambda _: self.config['actionTitle'],
                          handler=lambda task, config: notification.handle(task, config, wake=wake))
        notification.handle(self.record['testId'], self.config, wake=wake)
        self.assertEqual(wake.call_count, 1)

    def test_native_button_whitespace_is_not_normalized_to_consent(self):
        request = {'title': 'CE', 'message': 'CE', 'group': 'one',
                   'action': self.config['actionTitle'], 'timeout': 1}
        with mock.patch.object(notification.subprocess, 'run') as run:
            run.return_value = mock.Mock(returncode=0, stdout=self.config['actionTitle'] + ' \n')
            self.assertNotEqual(notification.terminal_notifier(request, '/bin/true'),
                                self.config['actionTitle'])

    def test_native_commands_are_argument_arrays_and_group_scoped(self):
        with mock.patch.object(notification.subprocess, 'run') as run:
            run.return_value = mock.Mock(returncode=0, stdout='@TIMEOUT\n')
            request = {'title': 'Pi → ChatGPT', 'message': '有新的 CE 任务待处理',
                       'group': 'ce-chatgpt-wake:CE-WAKE-TEST-01', 'action': '读取 CE 消息', 'timeout': 30}
            self.assertEqual(notification.terminal_notifier(request, '/opt/homebrew/bin/terminal-notifier'), '@TIMEOUT')
            args, kwargs = run.call_args
            self.assertEqual(args[0][0], '/opt/homebrew/bin/terminal-notifier')
            self.assertIn(request['group'], args[0])
            self.assertFalse(kwargs.get('shell', False))
        with mock.patch.object(notification.subprocess, 'run') as run:
            run.return_value = mock.Mock(returncode=0, stdout='')
            notification.remove_notification('group-id', '/opt/homebrew/bin/terminal-notifier')
            self.assertEqual(run.call_args.args[0], ['/opt/homebrew/bin/terminal-notifier', '-remove', 'group-id'])


if __name__ == '__main__':
    unittest.main()
