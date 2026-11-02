import datetime
import json
from pathlib import Path
import subprocess
import sys
import tempfile
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
                config.write_text(json.dumps({'runDirectory':str(root),'node':str(peer),'client':str(client),'isolatedHome':str(root),'desktopConfig':str(desktop),'outcome':outcome,'deadline':(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=20)).isoformat()}))
                result=subprocess.run([sys.executable,str(Path(__file__).with_name('supervise.py')),str(config)],capture_output=True,text=True,timeout=15)
                self.assertEqual(result.returncode,0,result.stderr)
                status=json.loads((root/'supervisor.json').read_text())
                self.assertEqual(status['state'],'CLOSED')
                self.assertTrue(status['peerGroupStopped'] and status['clientGroupStopped'])
                if outcome=='success':self.assertEqual(status['reason'],'COMPLETED')
                else:self.assertEqual(status['reason'],'RuntimeError:CHILD_EXITED')


if __name__=='__main__':unittest.main()
