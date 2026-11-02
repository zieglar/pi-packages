import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('bridge', Path(__file__).with_name('bridge.py'))
assert spec is not None and spec.loader is not None
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


def node(role, name='', **kw):
    return dict(role=role, name=name, **kw)


def view(draft='', messages=(), busy=False, target='test 的对话'):
    return {'version': '2.5', 'ok': True, 'data': {'app': 'Ovis', 'window': {'id': 'w-1', 'title': 'Ovis'}, 'complete': True, 'tree': node('window', children=[
        node('log', target, children=[node('text', x) for x in messages]),
        node('textfield', '消息', ref_id='@fresh:e1', value=draft),
        node('button', '停止 Agent' if busy else '发送消息', ref_id='@fresh:e2')])}}


class Desktop:
    def __init__(self, prompt, reply):
        self.prompt, self.reply = prompt, reply
        self.draft = ''
        self.sent = False
        self.clicks = 0
        self.unknown = False

    def prepare(self):
        pass

    def snapshot(self):
        return view(self.draft, [self.prompt, self.reply] if self.sent else [])

    def action(self, command, ref, text=None):
        if command == 'type':
            assert isinstance(text, str)
            self.draft = text
        elif command == 'click':
            self.clicks += 1
            self.sent = True
            self.draft = ''
            if self.unknown:
                raise TimeoutError('after delivery')
        return {'version': '2.5', 'ok': True, 'data': {'disposition': {'delivery': 'delivered_unverified', 'retry': 'unsafe'}}}


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.task = {'schemaVersion': 1, 'taskId': 'CE-OVIS-TEST-unit-01', 'target': 'test', 'testOnly': True, 'text': '中文 English 🚀\n第二行', 'deadline': '2099-01-01T00:00:00Z'}
        self.config = {'windowId': 'w-1', 'conversation': 'test 的对话', 'allowedTaskId': self.task['taskId'], 'allowedTextSha256': bridge.digest(self.task['text']), 'stateDir': self.tmp.name, 'maxWaitSeconds': 1, 'pollSeconds': 0.001}

    def test_success_and_repeat_never_submit_twice(self):
        prompt = bridge.prompt_for(self.task)
        d = Desktop(prompt, '中文 English ✅\n' + bridge.end_marker(self.task))
        r = bridge.run_task(self.task, self.config, d)
        self.assertEqual(r['ovisState'], 'COMPLETED')
        self.assertIn('中文 English', r['response'])
        again = bridge.run_task(self.task, self.config, d)
        self.assertEqual(again['ovisState'], 'COMPLETED')
        self.assertEqual(d.clicks, 1)
        self.assertEqual(again['taskId'], self.task['taskId'])
        self.assertEqual((Path(self.tmp.name) / (self.task['taskId'] + '.json')).stat().st_mode & 0o777, 0o600)

    def test_unknown_submit_is_never_replayed(self):
        d = Desktop(bridge.prompt_for(self.task), '')
        d.unknown = True
        self.assertEqual(bridge.run_task(self.task, self.config, d)['ovisState'], 'UNKNOWN')
        bridge.run_task(self.task, self.config, d)
        self.assertEqual(d.clicks, 1)

    def test_policy_denies_changed_text_before_desktop(self):
        self.task['text'] = 'business operation'
        with self.assertRaises(ValueError):
            bridge.run_task(self.task, self.config, None)

    def test_target_guard_rejects_other_chat_and_incomplete(self):
        with self.assertRaises(ValueError):
            bridge.observe(view(target='private chat'), self.config)
        v = view()
        v['data']['complete'] = False
        with self.assertRaises(ValueError):
            bridge.observe(v, self.config)

    def test_processing_is_not_completion_even_with_end_marker(self):
        v = bridge.observe(view(messages=[bridge.end_marker(self.task)], busy=True), self.config)
        self.assertEqual(bridge.classify(v, self.task)['ovisState'], 'PROCESSING')

    def test_plain_stable_text_is_unknown(self):
        v = bridge.observe(view(messages=['some stable text']), self.config)
        self.assertEqual(bridge.classify(v, self.task)['ovisState'], 'UNKNOWN')

    def test_same_id_changed_body_conflicts_even_if_reauthorized(self):
        d = Desktop(bridge.prompt_for(self.task), bridge.end_marker(self.task))
        bridge.run_task(self.task, self.config, d)
        self.task['text'] += 'changed'
        self.config['allowedTextSha256'] = bridge.digest(self.task['text'])
        with self.assertRaises(ValueError):
            bridge.run_task(self.task, self.config, d)
        self.assertEqual(d.clicks, 1)

    def test_concurrent_owner_blocks_before_desktop(self):
        import fcntl
        with (Path(self.tmp.name) / '.lock').open('w') as owner:
            fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                bridge.run_task(self.task, self.config, None)

    def test_process_restart_after_input_marker_never_types(self):
        import json
        task_hash = bridge.digest(json.dumps(self.task, sort_keys=True, ensure_ascii=False))
        saved = {'taskSha256': task_hash, 'stage': 'SUBMIT_MAY_HAVE_OCCURRED', 'result': {'ovisState': 'UNKNOWN'}}
        (Path(self.tmp.name) / (self.task['taskId'] + '.json')).write_text(json.dumps(saved))
        self.assertEqual(bridge.run_task(self.task, self.config, None)['ovisState'], 'UNKNOWN')

    def test_chunk_input_uses_fresh_ref_and_exact_cumulative_readback(self):
        cli = object.__new__(bridge.DesktopCli)
        cli.config = dict(self.config, headedAuthorized=True)
        value = ''
        seen = []
        def call(args):
            nonlocal value
            seen.append(args)
            value += args[-1]
            return {'ok': True}
        def snapshot():
            v = view(value)
            v['data']['tree']['children'][1]['ref_id'] = '@after' + str(len(value)) + ':e1'
            return v
        cli.call = call
        cli.snapshot = snapshot
        text = '中文 English 🚀\n第二行'
        cli.action('type', '@initial:e1', text)
        self.assertEqual(value, text)
        self.assertEqual(seen[0][2], '@initial:e1')
        self.assertNotEqual(seen[1][2], '@initial:e1')
        self.assertTrue(all(len(a[-1]) <= 8 for a in seen))

    def test_failed_ui_is_distinct_from_unknown(self):
        v = view()
        v['data']['tree']['children'][-1]['name'] = '重试'
        result = bridge.classify(bridge.observe(v, self.config), self.task)
        self.assertEqual(result['ovisState'], 'FAILED')

    def test_nonempty_draft_not_overwritten(self):
        d = Desktop('', '')
        d.draft = 'existing private draft'
        r = bridge.run_task(self.task, self.config, d)
        self.assertEqual(r['ovisState'], 'UNKNOWN')
        self.assertEqual(d.draft, 'existing private draft')
        self.assertEqual(d.clicks, 0)

    def test_repeated_reply_text_and_timestamp_preserved(self):
        prompt = bridge.prompt_for(self.task)
        v = view(messages=prompt.splitlines() + ['10:57'] + self.task['text'].splitlines() + [bridge.end_marker(self.task), '10:57'])
        result = bridge.classify(bridge.observe(v, self.config), self.task)
        self.assertEqual(result['ovisState'], 'COMPLETED')
        self.assertEqual(result['response'], self.task['text'])

    def test_mismatched_draft_stops_before_send(self):
        d = Desktop('', '')
        original = d.action
        def corrupt(command, ref, text=None):
            result = original(command, ref, text)
            if command == 'type':
                d.draft = 'truncated'
            return result
        d.action = corrupt
        result = bridge.run_task(self.task, self.config, d)
        self.assertEqual(result['ovisState'], 'UNKNOWN')
        self.assertEqual(d.clicks, 0)

    def test_target_selection_reobserves_before_text_input(self):
        cli = object.__new__(bridge.DesktopCli)
        cli.config = dict(self.config, agentButtonPrefix='pi: test pi-2 ·')
        other = view(target='other 的对话')
        other['data']['tree']['children'].append(node('button', 'pi: test pi-2 · host · CE-OVIS-TEST-01', ref_id='@observed:e9'))
        snapshots = iter([other, view()])
        cli.snapshot = lambda: next(snapshots)
        calls = []
        cli.call = lambda args: calls.append(args)
        cli.prepare()
        self.assertEqual(calls, [['click', '@observed:e9']])

    def test_target_selection_refuses_ambiguous_agent(self):
        cli = object.__new__(bridge.DesktopCli)
        cli.config = dict(self.config, agentButtonPrefix='pi: test pi-2 ·')
        v = view(target='other 的对话')
        v['data']['tree']['children'] += [node('button', 'pi: test pi-2 · one'), node('button', 'pi: test pi-2 · two')]
        cli.snapshot = lambda: v
        cli.call = lambda args: self.fail('must not click ambiguous target')
        with self.assertRaisesRegex(ValueError, 'TARGET_AGENT_NOT_UNIQUE'):
            cli.prepare()

    def test_matching_conversation_does_not_bypass_agent_selection(self):
        for count in (0, 1, 2):
            with self.subTest(candidates=count):
                cli = object.__new__(bridge.DesktopCli)
                cli.config = dict(self.config, agentButtonPrefix='pi: test pi-2 ·')
                current = view()
                current['data']['tree']['children'] += [node('button', 'pi: test pi-2 · candidate ' + str(i), ref_id='@candidate:e' + str(i)) for i in range(count)]
                snapshots = iter([current, view()])
                cli.snapshot = lambda: next(snapshots)
                calls = []
                cli.call = lambda args: calls.append(args)
                if count == 1:
                    cli.prepare()
                    self.assertEqual(calls, [['click', '@candidate:e0']])
                else:
                    with self.assertRaisesRegex(ValueError, 'TARGET_AGENT_NOT_UNIQUE'):
                        cli.prepare()
                    self.assertEqual(calls, [])

    def test_selected_agent_readback_must_match_conversation(self):
        cli = object.__new__(bridge.DesktopCli)
        cli.config = dict(self.config, agentButtonPrefix='pi: test pi-2 ·')
        current = view()
        current['data']['tree']['children'].append(node('button', 'pi: test pi-2 · candidate', ref_id='@candidate:e0'))
        snapshots = iter([current, view(target='wrong 的对话')])
        cli.snapshot = lambda: next(snapshots)
        cli.call = lambda args: None
        with self.assertRaisesRegex(ValueError, 'CONVERSATION_OR_INPUT_MISMATCH'):
            cli.prepare()

    def test_stop_reason_preserves_safe_code(self):
        d = Desktop('', '')
        d.snapshot = lambda: view(target='other 的对话')
        result = bridge.run_task(self.task, self.config, d)
        self.assertEqual(result['reason'], 'CONVERSATION_OR_INPUT_MISMATCH')
        self.assertEqual(d.clicks, 0)

    def test_input_time_consumes_total_execution_budget(self):
        from unittest.mock import patch
        clock = [0.0]
        self.config['maxWaitSeconds'] = 300
        d = Desktop(bridge.prompt_for(self.task), bridge.end_marker(self.task))
        original = d.action
        def slow(command, ref, text=None):
            result = original(command, ref, text)
            if command == 'type':
                clock[0] = 301.0
            return result
        d.action = slow
        with patch.object(bridge.time, 'monotonic', side_effect=lambda: clock[0]):
            result = bridge.run_task(self.task, self.config, d)
        self.assertEqual(result['reason'], 'TASK_EXECUTION_DEADLINE')
        self.assertEqual(d.clicks, 0)

    def test_desktop_subprocess_timeout_uses_remaining_budget(self):
        from unittest.mock import patch
        import json
        cli = object.__new__(bridge.DesktopCli)
        cli.config = dict(self.config, executionEnd=12.0, desktopTmpDir=self.tmp.name)
        cli.prefix, cli.env = ['unused'], {}
        response = type('Response', (), {'stdout': json.dumps({'version':'2.5','ok':True})})()
        with patch.object(bridge.time, 'monotonic', return_value=10.0), patch.object(bridge.subprocess, 'run', return_value=response) as run:
            cli.call(['snapshot'])
        self.assertEqual(run.call_args.kwargs['timeout'], 2.0)

    def test_closed_task_schema(self):
        self.task['command'] = 'rm'
        with self.assertRaises(ValueError):
            bridge.run_task(self.task, self.config, None)


if __name__ == '__main__':
    unittest.main()
