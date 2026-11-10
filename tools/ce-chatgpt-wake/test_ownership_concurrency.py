from concurrent.futures import ThreadPoolExecutor
import tempfile
from pathlib import Path
import unittest

import ownership_guard as guard
from test_ownership_guard import REQUEST, OUT, IN, SCOPE
from test_wake import Desktop


class DurableOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'registry'
        self.store = guard.Store(self.root, SCOPE)
        self.store.register(REQUEST, 'synthetic-project', 'synthetic-owner', confirmation='EXPLICIT_USER')
        self.p = self.store.associate(REQUEST, {'messageId': OUT, 'disposition': 'CREATED', **SCOPE})
        self.cfg = {'windowId': 'w-1', 'maxWaitSeconds': 1}

    def test_concurrent_duplicate_probes_submit_once(self):
        desktops = [Desktop(), Desktop()]
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(guard.Store(self.root, SCOPE).attempt, OUT, self.cfg, desk) for desk in desktops]
            results = [f.result(timeout=8) for f in futures]
        self.assertEqual(sum(d.sends for d in desktops), 1)
        self.assertTrue(all(r['noticeSubmission'] == 'OBSERVED' for r in results))

    def test_concurrent_feedback_notifications_post_once(self):
        self.store.attempt(OUT, self.cfg, Desktop())
        envelope = {'messageId': IN, 'exchangeId': SCOPE['exchangeId'], 'from': SCOPE['to'], 'to': SCOPE['from']}
        body = {k: self.p[k] for k in ('messageId', 'requestMessageId', 'probeId')}
        body.update(protocol='ce.task-owner-feedback.v1', outcome='WRONG_CONVERSATION')
        self.store.feedback(envelope, body)
        posted = []
        def notify(request):
            posted.append(request)
            return '@CLOSED'
        nc = {'terminalNotifier': '/synthetic', 'timeoutSeconds': 1, 'actionTitle': '检查当前对话'}
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(guard.Store(self.root, SCOPE).notify, OUT, self.cfg, nc,
                                       notifier=notify, desktop_factory=Desktop) for _ in range(2)]
            [f.result(timeout=8) for f in futures]
        self.assertEqual(len(posted), 1)

    def test_restart_after_uncertain_input_cannot_retry(self):
        desktop = Desktop()
        def uncertain(ref, text):
            raise TimeoutError()
        desktop.fill = uncertain
        self.store.attempt(OUT, self.cfg, desktop)
        new = guard.Store(self.root, SCOPE)
        untouched = Desktop()
        self.assertEqual(new.attempt(OUT, self.cfg, untouched)['noticeSubmission'], 'UNKNOWN')
        self.assertEqual(untouched.draft, '')
        self.assertEqual(untouched.sends, 0)


if __name__ == '__main__':
    unittest.main()
