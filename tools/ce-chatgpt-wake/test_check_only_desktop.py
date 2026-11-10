import copy
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import check_only_desktop as desktop


def window(**changes):
    return dict({'id': 'window-1', 'pid': 42, 'process_instance': 'instance-1',
                 'is_focused': True, 'accessible': True, 'visible': True, 'minimized': False}, **changes)


def snapshot(draft='询问 ChatGPT\n', input_ref='input-fresh', send_ref='send-fresh', *, stop=False, disabled=None):
    if disabled is None:
        disabled = draft in ('', '询问 ChatGPT\n')
    children = [{'role': 'textfield', 'name': '询问 ChatGPT', 'value': draft, 'ref_id': input_ref},
                {'role': 'button', 'name': '发送', 'ref_id': send_ref,
                 'states': ['disabled'] if disabled else []}]
    if stop:
        children.append({'role': 'button', 'name': '停止'})
    return {'version': '2.5', 'ok': True, 'data': {'complete': True, 'app': 'ChatGPT',
            'window': {'id': 'window-1'}, 'tree': {'role': 'webarea', 'children': children}}}


class ForegroundTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root)
        self.authority = mock.Mock()
        self.config = {'stateDir': self.root, 'agentDesktop': '/usr/bin/true',
                       'desktopSession': 'old', 'checkAuthority': self.authority}
        self.scoped = [window()]
        self.global_windows = [window()]
        self.view = snapshot()
        self.calls = []
        self.patcher = mock.patch.object(desktop.wake.ChatGptCli, 'call', lambda cli, args: self.call(args))
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        no_process = mock.patch('subprocess.run', side_effect=AssertionError('REAL_PROCESS_FORBIDDEN'))
        no_process.start()
        self.addCleanup(no_process.stop)

    def call(self, args):
        self.calls.append(args)
        if args == ['list-windows', '--app', 'ChatGPT']:
            return {'data': copy.deepcopy(self.scoped)}
        if args == ['list-windows']:
            return {'data': copy.deepcopy(self.global_windows)}
        if args[0] == 'snapshot':
            return copy.deepcopy(self.view)
        if args[0] == 'get':
            return {'data': {'ref': args[1], 'property': 'value',
                             'value': self.view['data']['tree']['children'][0].get('value')}}
        if args[0] == 'is':
            send = next(n for n in self.view['data']['tree']['children'] if n.get('name') == '发送')
            return {'data': {'ref': args[1], 'property': 'enabled', 'applicable': True,
                             'result': send.get('states') != ['disabled']}}
        if args[0] in ('set-value', 'click'):
            return {'data': {}}
        self.fail('unexpected desktop command')

    def make(self):
        old_tmp = self.config.get('desktopTmpDir')
        try:
            return desktop.desktop_for(self.config)
        finally:
            new_tmp = self.config.get('desktopTmpDir')
            if new_tmp and new_tmp != old_tmp:
                self.addCleanup(shutil.rmtree, new_tmp)

    def test_selects_unique_foreground_with_isolated_session_and_environment(self):
        with mock.patch.dict(os.environ, {'SECRET_TEST_CREDENTIAL': 'secret'}):
            cli = self.make()
        self.assertEqual((self.config['windowId'], self.config['pid'], self.config['processInstance']),
                         ('window-1', 42, 'instance-1'))
        self.assertNotEqual(self.config['desktopSession'], 'old')
        self.assertNotIn('SECRET_TEST_CREDENTIAL', cli.env)
        self.assertEqual(cli.env['TMPDIR'], self.config['desktopTmpDir'])
        self.assertEqual(Path(self.config['desktopTmpDir']).stat().st_mode & 0o777, 0o700)
        self.assertIn(['list-windows'], self.calls)
        self.assertEqual(cli.prefix, ['/usr/bin/true', '--session', self.config['desktopSession']])
        old_tmp, old_session = self.config['desktopTmpDir'], self.config['desktopSession']
        self.make()
        self.assertNotEqual(self.config['desktopTmpDir'], old_tmp)
        self.assertNotEqual(self.config['desktopSession'], old_session)

    def test_global_minimized_omitted_uses_scoped_nonminimized_proof(self):
        del self.global_windows[0]['minimized']
        self.make()
        self.assertEqual(self.config['windowId'], 'window-1')

    def test_scoped_focus_is_not_global_focus(self):
        self.global_windows = [window(is_focused=False), window(id='other', pid=43, is_focused=True)]
        with self.assertRaises(ValueError):
            self.make()
        self.assertFalse(any(c[0] in ('set-value', 'click') for c in self.calls))

    def test_ambiguous_or_unsafe_windows_are_rejected(self):
        cases = [([window(), window(id='second')], [window()]),
                 ([window()], [window(is_focused=False)]),
                 ([window()], [window(), window(id='second')]),
                 ([window(accessible=False)], [window()]),
                 ([window(visible=False)], [window()]),
                 ([window(minimized=True)], [window()]),
                 ([window(accessible=1)], [window()]),
                 ([window(visible=1)], [window()]),
                 ([window(minimized=0)], [window()]),
                 ([window()], [window(minimized=True)]),
                 ([window()], [window(minimized=None)]),
                 ([window()], [window(minimized=0)]),
                 ([{k: v for k, v in window().items() if k != 'minimized'}], [window()]),
                 ([window()], [window(visible=False)]),
                 ([window()], [window(accessible=False)]),
                 ([window()], [window(is_focused=1)])]
        for scoped, global_windows in cases:
            with self.subTest(scoped=scoped, global_windows=global_windows):
                self.scoped, self.global_windows = scoped, global_windows
                with self.assertRaises(ValueError):
                    self.make()

    def test_process_or_focus_change_blocks_snapshot_and_mutation(self):
        for field, value in [('id', 'different'), ('pid', 43), ('process_instance', 'new'), ('is_focused', False)]:
            with self.subTest(field=field):
                self.scoped, self.global_windows = [window()], [window()]
                cli = self.make()
                self.global_windows = [window(**{field: value})]
                with self.assertRaises(ValueError):
                    cli.fill('stale', 'fixed prompt')
                self.assertFalse(any(c[0] in ('set-value', 'click') for c in self.calls))

    def test_fill_and_submit_use_fresh_refs_and_authority(self):
        cli = self.make()
        cli.fill('stale-input', 'fixed prompt')
        self.view = snapshot('fixed prompt', send_ref='new-send')
        cli.submit('stale-send')
        self.assertEqual([c for c in self.calls if c[0] in ('set-value', 'click')],
                         [['set-value', 'input-fresh', 'fixed prompt'], ['click', 'new-send']])
        self.assertEqual(self.authority.call_count, 4)

    def test_unsafe_views_never_mutate(self):
        views = [snapshot('existing draft'), snapshot(stop=True)]
        duplicate = snapshot()
        duplicate['data']['tree']['children'].append(dict(duplicate['data']['tree']['children'][0]))
        views.append(duplicate)
        incomplete = snapshot()
        incomplete['data']['complete'] = False
        views.append(incomplete)
        for view in views:
            with self.subTest(view=view):
                self.scoped, self.global_windows, self.view = [window()], [window()], view
                cli = self.make()
                with self.assertRaises(ValueError):
                    cli.fill('stale', 'fixed prompt')
        self.assertFalse(any(c[0] in ('set-value', 'click') for c in self.calls))

    def test_submit_rejects_mismatched_draft_disabled_and_authority_failure(self):
        cli = self.make()
        cli.fill('old', 'fixed prompt')
        for view in [snapshot('different'), snapshot('fixed prompt', disabled=True), snapshot('fixed prompt', stop=True)]:
            self.view = view
            with self.assertRaises(ValueError):
                cli.submit('old')
        self.view = snapshot('fixed prompt')
        self.authority.side_effect = ValueError('AUTHORITY_DENIED')
        with self.assertRaises(ValueError):
            cli.submit('old')
        self.assertFalse(any(c[0] == 'click' for c in self.calls))

    def test_authority_failure_prevents_fill(self):
        cli = self.make()
        self.authority.side_effect = ValueError('AUTHORITY_DENIED')
        with self.assertRaises(ValueError):
            cli.fill('old', 'fixed prompt')
        self.assertFalse(any(c[0] == 'set-value' for c in self.calls))

    def test_raw_snapshot_requires_exact_complete_version_app_and_window(self):
        cli = self.make()
        for field, value in [('version', '2.4'), ('ok', 1)]:
            self.view = snapshot()
            self.view[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                cli.snapshot()
        for field, value in [('complete', 1), ('app', 'Other'), ('window', {'id': 'other'})]:
            self.view = snapshot()
            self.view['data'][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                cli.snapshot()

    def test_changed_selected_identity_blocks_snapshot_before_capture(self):
        cli = self.make()
        for field, value in [('id', 'other'), ('pid', 43), ('process_instance', 'new')]:
            self.scoped = [window(**{field: value})]
            self.global_windows = copy.deepcopy(self.scoped)
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'CHATGPT_PROCESS_OR_WINDOW_CHANGED'):
                cli.snapshot()
        self.assertFalse(any(c[0] == 'snapshot' for c in self.calls))

    def test_titles_and_marker_do_not_select_identity(self):
        self.scoped[0]['title'] = 'untrusted title'
        self.global_windows[0]['title'] = 'different title'
        self.config['conversationMarker'] = 'not present'
        cli = self.make()
        cli.snapshot()

    def test_busy_post_submit_observation_remains_available(self):
        cli = self.make()
        self.view = snapshot('', stop=True)
        self.view['data']['tree']['children'].pop(1)
        self.assertEqual(cli.snapshot(), self.view)
        with self.assertRaises(ValueError):
            cli.fill('old', 'fixed prompt')

    def test_missing_or_duplicate_send_blocks_input(self):
        cli = self.make()
        for count in (0, 2):
            self.view = snapshot()
            children = self.view['data']['tree']['children']
            send = children.pop()
            children.extend([dict(send)] * count)
            with self.subTest(count=count), self.assertRaises(ValueError):
                cli.fill('old', 'fixed prompt')
        self.assertFalse(any(c[0] == 'set-value' for c in self.calls))

    def test_foreground_loss_before_submit_blocks_click(self):
        cli = self.make()
        cli.fill('old', 'fixed prompt')
        self.view = snapshot('fixed prompt')
        self.global_windows = [window(is_focused=False)]
        with self.assertRaises(ValueError):
            cli.submit('old')
        self.assertFalse(any(c[0] == 'click' for c in self.calls))

    def test_submit_requires_a_prior_fill_and_fresh_authority_callable(self):
        cli = self.make()
        with self.assertRaises(ValueError):
            cli.submit('old')
        cli.fill('old', 'fixed prompt')
        self.view = snapshot('fixed prompt')
        changed_authority = mock.Mock(side_effect=ValueError('ENTRY_CLOSED'))
        self.config['checkAuthority'] = changed_authority
        with self.assertRaisesRegex(ValueError, 'ENTRY_CLOSED'):
            cli.submit('old')
        changed_authority.assert_called_once_with()
        self.assertFalse(any(c[0] == 'click' for c in self.calls))

    def test_optional_snapshot_states_must_be_well_formed_when_present(self):
        cli = self.make()
        cli.fill('old', 'fixed prompt')
        for states in (None, 'enabled', 1):
            self.view = snapshot('fixed prompt')
            self.view['data']['tree']['children'][1]['states'] = states
            with self.subTest(states=states), self.assertRaises(ValueError):
                cli.submit('old')
        self.view = snapshot('fixed prompt')
        del self.view['data']['tree']['children'][1]['states']
        cli.submit('old')
        self.assertEqual([c for c in self.calls if c[0] == 'click'], [['click', 'send-fresh']])

    def test_foreground_change_during_authority_check_prevents_input_and_submit(self):
        cli = self.make()
        def change_foreground():
            self.global_windows = [window(is_focused=False), window(id='other', pid=43, is_focused=True)]
        self.authority.side_effect = change_foreground
        with self.assertRaisesRegex(ValueError, 'CHATGPT_NOT_FOREGROUND'):
            cli.fill('old', 'fixed prompt')
        self.global_windows = [window()]
        self.view = snapshot('fixed prompt')
        cli.expected_prompt = 'fixed prompt'
        cli.input_attempted = True
        with self.assertRaisesRegex(ValueError, 'CHATGPT_NOT_FOREGROUND'):
            cli.submit('old')
        self.assertFalse(any(c[0] in ('set-value', 'click') for c in self.calls))

    def test_authority_callable_is_required_before_selection(self):
        self.config['checkAuthority'] = None
        with self.assertRaisesRegex(ValueError, 'CHECK_AUTHORITY_REQUIRED'):
            self.make()
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
