import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('lifecycle', Path(__file__).with_name('lifecycle.py'))
assert spec is not None and spec.loader is not None
lifecycle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lifecycle)


class LifecycleTests(unittest.TestCase):
    def test_reaped_group_leader_does_not_hide_live_descendant(self):
        with tempfile.TemporaryDirectory() as directory:
            pidfile = Path(directory) / 'child.pid'
            code = "import subprocess,sys; p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); open(sys.argv[1],'w').write(str(p.pid))"
            leader = subprocess.Popen([sys.executable, '-c', code, str(pidfile)], start_new_session=True)
            leader.wait(timeout=5)
            child = int(pidfile.read_text())
            try:
                self.assertIn(child, lifecycle.group_members(leader.pid))
                self.assertTrue(lifecycle.stop_group(leader, grace=0.2))
                self.assertEqual(lifecycle.group_members(leader.pid), [])
            finally:
                if lifecycle.group_members(leader.pid):
                    os.killpg(leader.pid, 9)

    def test_supervisor_cleans_orphans_and_detached_host_after_peer_exit(self):
        import datetime
        import json
        if sys.platform != 'darwin':
            self.skipTest('macOS host lifecycle')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            namespace = root / 'ax'
            namespace.mkdir(mode=0o700)
            desktop = root / 'desktop.json'
            desktop.write_text(json.dumps({'desktopTmpDir':str(namespace),'agentDesktop':sys.executable}))
            fake = root / 'fake-node'
            fake.write_text('#!' + sys.executable + '\n' + "import subprocess,sys,pathlib,json\nr=pathlib.Path.cwd()\np=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])\n(r/'orphan.pid').write_text(str(p.pid))\nh=subprocess.Popen([sys.executable,'-c',\"import socket,time,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); print('ready',flush=True); time.sleep(60)\",str(r/'ax'/'host.sock')],start_new_session=True,stdout=subprocess.PIPE,text=True)\nassert h.stdout.readline().strip()=='ready'\n(r/'host.pid').write_text(str(h.pid))\n(r/'peer-ready.json').write_text('{}')\nraise SystemExit(1)\n")
            fake.chmod(0o700)
            config = {'runDirectory':directory,'deadline':(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=20)).isoformat(),'desktopConfig':str(desktop),'isolatedHome':directory,'node':str(fake),'client':sys.executable}
            cfg = root / 'config.json'
            cfg.write_text(json.dumps(config))
            supervisor = Path(__file__).with_name('supervise.py')
            p = subprocess.run([sys.executable,str(supervisor),str(cfg)],capture_output=True,text=True,timeout=25)
            self.assertEqual(p.returncode,0,p.stderr)
            status = json.loads((root/'supervisor.json').read_text())
            self.assertEqual(status['state'],'CLOSED',status)
            self.assertTrue(status['peerGroupStopped'])
            self.assertTrue(status['desktopHostsStopped'])
            self.assertEqual(lifecycle.group_members(status['peerPid']),[])
            self.assertEqual(lifecycle.namespace_hosts(namespace),set())

    def test_delayed_socket_bind_is_cleaned_but_not_claimed_confirmed(self):
        if sys.platform != 'darwin':
            self.skipTest('macOS host lifecycle')
        with tempfile.TemporaryDirectory() as directory:
            sock = str(Path(directory) / 'late.sock')
            code = "import socket,time,sys; print('started',flush=True); time.sleep(.3); s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); time.sleep(30)"
            child = subprocess.Popen([sys.executable,'-c',code,sock],stdout=subprocess.PIPE,text=True)
            assert child.stdout is not None
            self.addCleanup(child.stdout.close)
            try:
                self.assertEqual(child.stdout.readline().strip(),'started')
                self.assertEqual(lifecycle.namespace_hosts(directory),set())
                identity = lifecycle.host_identity(child.pid)
                self.assertFalse(lifecycle.stop_hosts(directory,identity[0],startup_uncertain=True))
                child.wait(timeout=2)
                self.assertEqual(lifecycle.namespace_hosts(directory),set())
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait()

    def test_private_namespace_host_cleanup_only_signals_matching_executable(self):
        if sys.platform != 'darwin':
            self.skipTest('macOS lsof host ownership')
        with tempfile.TemporaryDirectory() as directory:
            sock = str(Path(directory) / 'test.sock')
            code = "import socket,time,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); print('READY',flush=True); time.sleep(60)"
            child = subprocess.Popen([sys.executable, '-c', code, sock], stdout=subprocess.PIPE, text=True)
            assert child.stdout is not None
            self.addCleanup(child.stdout.close)
            try:
                self.assertEqual(child.stdout.readline().strip(), 'READY')
                with self.assertRaisesRegex(ValueError, 'DESKTOP_HOST_IDENTITY_MISMATCH'):
                    lifecycle.stop_hosts(directory, '/does/not/match')
                self.assertIsNone(child.poll())
                identity = lifecycle.host_identity(child.pid)
                self.assertTrue(lifecycle.stop_hosts(directory, identity[0]))
                child.wait(timeout=3)
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait()
