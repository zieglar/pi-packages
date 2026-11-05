import json
import tempfile
import unittest
from pathlib import Path

from test_bridge import Desktop, bridge, view


class TaskModeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.task = {'schemaVersion': 1, 'taskId': 'CE-OVIS-TASK-unit-01', 'target': 'test',
                     'testOnly': False, 'text': '中文 English 🚀\n第二行', 'deadline': '2099-01-01T00:00:00Z'}
        self.config = {'windowId': 'w-1', 'conversation': 'test 的对话', 'allowedTaskId': self.task['taskId'],
                       'allowedTextSha256': bridge.digest(self.task['text']), 'stateDir': self.tmp.name,
                       'maxWaitSeconds': 1, 'pollSeconds': 0.001, 'taskMode': 'execute'}

    def test_default_denies_real_task(self):
        del self.config['taskMode']
        with self.assertRaises(ValueError):
            bridge.run_task(self.task, self.config, None)

    def test_real_prompt_and_completion_report(self):
        prompt = bridge.prompt_for(self.task)
        self.assertIn(self.task['text'], prompt)
        self.assertNotIn('仅回显', prompt)
        desktop = Desktop(prompt, '任务已处理\n' + bridge.end_marker(self.task))
        result = bridge.run_task(self.task, self.config, desktop)
        self.assertEqual(result['desktopSubmission'], 'OBSERVED')
        self.assertEqual(result['completionReport'], 'REPORTED')
        self.assertEqual(result['taskCompletion'], 'UNVERIFIED')
        self.assertEqual(result['ovisState'], 'REPORTED')
        self.assertFalse(result['agentProcessingObserved'])
        self.assertEqual(bridge.run_task(self.task, self.config, desktop), result)
        self.assertEqual(desktop.clicks, 1)

    def test_processing_evidence_survives_idle_report(self):
        prompt = bridge.prompt_for(self.task)
        desktop = Desktop(prompt, bridge.end_marker(self.task))
        original = desktop.snapshot
        busy_seen = False
        def snapshot():
            nonlocal busy_seen
            if desktop.sent and not busy_seen:
                busy_seen = True
                return view(messages=[prompt], busy=True)
            return original()
        desktop.snapshot = snapshot
        result = bridge.run_task(self.task, self.config, desktop)
        self.assertTrue(result['agentProcessingObserved'])
        self.assertEqual(result['taskCompletion'], 'UNVERIFIED')
        saved = json.loads((Path(self.tmp.name) / (self.task['taskId'] + '.json')).read_text())
        self.assertTrue(saved['result']['agentProcessingObserved'])

    def test_uncertain_submission_has_no_completion(self):
        desktop = Desktop(bridge.prompt_for(self.task), '')
        desktop.unknown = True
        result = bridge.run_task(self.task, self.config, desktop)
        self.assertEqual(result['desktopSubmission'], 'UNKNOWN')
        self.assertEqual(result['completionReport'], 'UNKNOWN')
        self.assertEqual(result['taskCompletion'], 'UNVERIFIED')
        bridge.run_task(self.task, self.config, desktop)
        self.assertEqual(desktop.clicks, 1)


if __name__ == '__main__':
    unittest.main()
