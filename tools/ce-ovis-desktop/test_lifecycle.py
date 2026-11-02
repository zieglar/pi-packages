import contextlib
import datetime
import importlib.util
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

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
            config = {'runDirectory':directory,'deadline':(datetime.datetime.now(datetime.UTC)+datetime.timedelta(seconds=20)).isoformat(),'desktopConfig':str(desktop),'isolatedHome':directory,'node':str(fake),'client':sys.executable}
            cfg = root / 'config.json'
            cfg.write_text(json.dumps(config))
            supervisor = Path(__file__).with_name('supervise.py')
            # Isolate only the unrelated Client inventory; real process/host cleanup still runs.
            runner = ('import runpy,subprocess,sys,pathlib; from unittest.mock import patch; '
                      'sys.path.insert(0,str(pathlib.Path(sys.argv[1]).parent)); '
                      'original=subprocess.check_output; '
                      'inventory=lambda args,*a,**k: "" if args==["/bin/ps","-axo","pid=,command="] else original(args,*a,**k); '
                      'sys.argv=sys.argv[1:]; '
                      'guard=patch("subprocess.check_output",side_effect=inventory); guard.start(); '
                      'runpy.run_path(sys.argv[0],run_name="__main__")')
            p = subprocess.run([sys.executable,'-c',runner,str(supervisor),str(cfg)],capture_output=True,text=True,timeout=25)
            self.assertEqual(p.returncode,0,p.stderr)
            status = json.loads((root/'supervisor.json').read_text())
            self.assertEqual(status['state'],'CLOSED',status)
            self.assertTrue(status['peerGroupStopped'])
            self.assertTrue(status['desktopHostsStopped'])
            self.assertEqual(lifecycle.group_members(status['peerPid']),[])
            self.assertEqual(lifecycle.namespace_hosts(namespace),set())

    def test_sigterm_during_health_probe_stops_peer_immediately(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            peer=root/'peer-stub'
            peer.write_text('#!'+sys.executable+'\n'+'''import pathlib,sys,time
r=pathlib.Path(sys.argv[3]).parent
(r/'peer-ready.json').write_text('{}')
(r/'stop-request').unlink(missing_ok=True)
while not (r/'stop-request').exists():time.sleep(.02)
(r/'peer-stopped').write_text('{}')
''')
            peer.chmod(0o700)
            client=root/'client-stub'
            client.write_text('#!'+sys.executable+'\n'+'''import json,os,pathlib,signal,sys,time
signal.signal(signal.SIGTERM,lambda *_:sys.exit(0))
if sys.argv[1]=='health':
 r=pathlib.Path(sys.argv[3]).parent
 (r/'probe-started').write_text(json.dumps({'pid':os.getpid()}))
 time.sleep(30)
else:
 r=pathlib.Path(sys.argv[2]).parent
 (r/'health.url').write_text('test')
 while True:time.sleep(.1)
''')
            client.chmod(0o700)
            desktop=root/'desktop.json'
            desktop.write_text(json.dumps({'desktopTmpDir':str(root/'ax'),'agentDesktop':'/bin/true'}))
            config=root/'config.json'
            config.write_text(json.dumps({'runDirectory':str(root),'node':str(peer),'client':str(client),'isolatedHome':str(root),'desktopConfig':str(desktop),'deadline':(datetime.datetime.now(datetime.UTC)+datetime.timedelta(seconds=30)).isoformat()}))
            supervisor=Path(__file__).with_name('supervise.py')
            runner=('import runpy,subprocess,sys,pathlib; from unittest.mock import patch; '
                    'sys.path.insert(0,str(pathlib.Path(sys.argv[1]).parent)); '
                    'original=subprocess.check_output; '
                    'inventory=lambda args,*a,**k: "" if args==["/bin/ps","-axo","pid=,command="] else original(args,*a,**k); '
                    'sys.argv=sys.argv[1:]; '
                    'guard=patch("subprocess.check_output",side_effect=inventory); guard.start(); '
                    'runpy.run_path(sys.argv[0],run_name="__main__")')
            process=subprocess.Popen([sys.executable,'-c',runner,str(supervisor),str(config)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            assert process.stdout is not None and process.stderr is not None
            try:
                deadline=time.time()+10
                while not (root/'probe-started').exists():
                    self.assertIsNone(process.poll(),process.stderr.read() if process.poll() is not None else '')
                    self.assertLess(time.time(),deadline,'health probe did not start')
                    time.sleep(.02)
                started=time.monotonic()
                process.send_signal(signal.SIGTERM)
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.fail('SIGTERM was delayed by the health subprocess')
                self.assertLess(time.monotonic()-started,2,'SIGTERM was delayed by the health subprocess')
                self.assertTrue((root/'peer-stopped').exists(),'peer did not observe the stop boundary')
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait()
                for marker in ('probe-started','supervisor.json'):
                    if not (root/marker).exists():
                        continue
                    data=json.loads((root/marker).read_text())
                    pids=[data['pid']] if marker=='probe-started' else [data.get('peerPid'),data.get('clientPid')]
                    for pid in pids:
                        if pid is None:
                            continue
                        with contextlib.suppress(ProcessLookupError):
                            os.kill(pid,signal.SIGTERM)
                process.stdout.close()
                process.stderr.close()

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
