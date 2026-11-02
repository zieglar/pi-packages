import contextlib
import datetime
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest


class SupervisorTests(unittest.TestCase):
    def test_peer_exit_requires_completion_and_close_evidence(self):
        for outcome in ('success', 'missing', 'nonzero', 'failure', 'unclosed'):
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as temp:
                root=Path(temp)
                peer=root/'peer-stub'
                peer.write_text('#!'+sys.executable+'\n'+'''import json, pathlib, sys, time
c=json.loads(pathlib.Path(sys.argv[2]).read_text());r=pathlib.Path(c['runDirectory'])
(r/'peer-ready.json').write_text('{}')
time.sleep(.3)
if c['outcome']!='missing':(r/'completed.json').write_text(json.dumps({'rounds':2,'actualCeRepliesReadAndAcked':True}))
if c['outcome']!='unclosed':(r/'peer-closed.json').write_text('{}')
if c['outcome']=='failure':(r/'peer-failure.json').write_text('{}')
sys.exit(1 if c['outcome']=='nonzero' else 0)
''')
                peer.chmod(0o700)
                client=root/'client-stub'
                client.write_text('#!'+sys.executable+'\nimport signal,time,sys\nsignal.signal(signal.SIGTERM,lambda *_:sys.exit(0))\nwhile True:time.sleep(.1)\n')
                client.chmod(0o700)
                desktop=root/'desktop.json'
                desktop.write_text(json.dumps({'desktopTmpDir':str(root/'ax'),'agentDesktop':'/bin/true'}))
                config=root/'config.json'
                config.write_text(json.dumps({'runDirectory':str(root),'node':str(peer),'client':str(client),'isolatedHome':str(root),'desktopConfig':str(desktop),'outcome':outcome,'deadline':(datetime.datetime.now(datetime.UTC)+datetime.timedelta(seconds=20)).isoformat()}))
                # The fixture owns its stub Client; the user's real Client is outside this test.
                runner = ('import runpy,subprocess,sys,pathlib; from unittest.mock import patch; '
                          'sys.path.insert(0,str(pathlib.Path(sys.argv[1]).parent)); '
                          'original=subprocess.check_output; '
                          'inventory=lambda args,*a,**k: "" if args==["/bin/ps","-axo","pid=,command="] else original(args,*a,**k); '
                          'sys.argv=sys.argv[1:]; '
                          'guard=patch("subprocess.check_output",side_effect=inventory); guard.start(); '
                          'runpy.run_path(sys.argv[0],run_name="__main__")')
                result=subprocess.run([sys.executable,'-c',runner,str(Path(__file__).with_name('supervise.py')),str(config)],capture_output=True,text=True,timeout=15)
                self.assertEqual(result.returncode,0,result.stderr)
                status=json.loads((root/'supervisor.json').read_text())
                self.assertEqual(status['state'],'CLOSED')
                self.assertTrue(status['peerGroupStopped'] and status['clientGroupStopped'])
                if outcome=='success':
                    self.assertEqual(status['reason'],'COMPLETED')
                else:
                    self.assertEqual(status['reason'],'RuntimeError:CHILD_EXITED')

    def test_sigterm_during_health_probe_stops_peer_immediately(self):
        self.check_probe_stop('signal')

    def test_deadline_during_health_probe_stops_peer(self):
        self.check_probe_stop('deadline')

    def test_stop_file_during_health_probe_stops_peer(self):
        self.check_probe_stop('file')

    def check_probe_stop(self, trigger):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            peer=root/'peer-stub'
            peer.write_text('#!'+sys.executable+'\n'+'''import pathlib,sys,time
r=pathlib.Path(sys.argv[2]).parent
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
            config.write_text(json.dumps({'runDirectory':str(root),'node':str(peer),'client':str(client),'isolatedHome':str(root),'desktopConfig':str(desktop),'deadline':(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=2 if trigger=='deadline' else 30)).isoformat()}))
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
                if trigger=='signal':process.send_signal(signal.SIGTERM)
                elif trigger=='file':(root/'stop-request').write_text('stop')
                try:
                    process.wait(timeout=4 if trigger=='deadline' else 3)
                except subprocess.TimeoutExpired:
                    self.fail('SIGTERM was delayed by the health subprocess')
                self.assertLess(time.monotonic()-started,3.5 if trigger=='deadline' else 2,'stop was delayed by the health subprocess')
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


if __name__=='__main__':
    unittest.main()
