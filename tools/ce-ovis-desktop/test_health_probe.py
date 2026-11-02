import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

from health_probe import health_probe  # type: ignore[import-not-found]


class HealthProbeTests(unittest.TestCase):
    def test_successful_probe_returns_its_exit_status(self):
        with tempfile.TemporaryDirectory() as directory:
            probe = health_probe(
                [sys.executable, '-c', 'raise SystemExit(0)'],
                env=os.environ.copy(),
                cwd=directory,
                deadline=time.monotonic() + 2,
                stop_requested=lambda: False,
            )
            assert probe is not None
            self.assertEqual(probe.returncode, 0)

    def test_deadline_terminates_and_reaps_owned_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            pidfile = Path(directory) / 'probe.pid'
            code = "import os,sys,time; open(sys.argv[1],'w').write(str(os.getpid())); time.sleep(30)"
            started = time.monotonic()
            probe = health_probe(
                [sys.executable, '-c', code, str(pidfile)],
                env=os.environ.copy(),
                cwd=directory,
                deadline=started + 0.3,
                stop_requested=lambda: False,
            )
            self.assertIsNone(probe)
            self.assertLess(time.monotonic() - started, 2)
            with self.assertRaises(ChildProcessError):
                os.waitpid(int(pidfile.read_text()), os.WNOHANG)


if __name__ == '__main__':
    unittest.main()
