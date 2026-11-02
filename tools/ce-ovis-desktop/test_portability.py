import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('lifecycle', Path(__file__).with_name('lifecycle.py'))
assert spec is not None and spec.loader is not None
lifecycle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lifecycle)


class PortabilityTests(unittest.TestCase):
    def test_client_inventory(self):
        client = '/opt/My Tools/renamed-client'
        for command in ('tunnel-client run', '/opt/bin/tunnel-client run --config x',
                        client + ' run --config x', '"' + client + '" run --config x',
                        '/opt/bin/tunnel-client run --config /tmp/ctx-mode/profile'):
            with self.subTest(command=command):
                self.assertTrue(lifecycle.client_running(' 123 ' + command + '\n', client))
        for command in (client + ' health', client + ' runner', 'other-tunnel-client run',
                        '/opt/bin/tunnel-client health', '/opt/bin/tunnel-client run-other'):
            with self.subTest(command=command):
                self.assertFalse(lifecycle.client_running('123 ' + command, client))

    def test_other_renamed_receiver_path_is_explicitly_excluded(self):
        self.assertTrue(lifecycle.client_running('123 /old/receiver run --config selected', '/new/client', ['/old/receiver']))
        with self.assertRaisesRegex(ValueError,'EXISTING_CLIENT_PATHS_REQUIRED'):
            lifecycle.client_running('', '/new/client', ['relative-client'])
    def test_client_symlink_and_space_bearing_standard_path(self):
        with tempfile.TemporaryDirectory() as temp:
            binary=Path(temp)/'real client';binary.write_text('fixture')
            link=Path(temp)/'selected-client';link.symlink_to(binary)
            self.assertTrue(lifecycle.client_running('123 '+str(binary)+' run --config anything',str(link)))
            self.assertTrue(lifecycle.client_running('123 /opt/My Tools/tunnel-client run --config anything',str(link)))
    def test_child_environment_drops_inherited_ce_overrides(self):
        with patch.dict(os.environ, {'HOME': '/other/home', 'PATH': '/preserved/bin',
                                    'UNRELATED': 'keep', 'CE_ALLOWLIST': 'stale',
                                    'CE_STORE_DIR': '/real/store', 'CE_STORE_FILE': '/real/db',
                                    'CE_TUNNEL_OFFLINE_TEST': '1', 'CE_TUNNEL_PROFILE': '/wrong'}, clear=True):
            env = lifecycle.child_environment({'isolatedHome': '/isolated/home',
                                              'client': '/opt/client'}, Path('/run/window'))
        self.assertEqual({k: v for k, v in env.items() if k.startswith('CE_')},
                         {'CE_TUNNEL_PROFILE': '/run/window/tunnel.yaml',
                          'CE_TUNNEL_CLIENT_PATH': '/opt/client'})
        self.assertEqual(env['HOME'], '/isolated/home')
        self.assertEqual(env['XDG_CONFIG_HOME'], '/isolated/home/.config')
        self.assertEqual(env['PATH'], '/preserved/bin')
        self.assertEqual(env['UNRELATED'], 'keep')

    def test_executable_validation_does_not_execute_and_is_cwd_independent(self):
        with tempfile.TemporaryDirectory() as temp:
            executable = Path(temp) / 'native tool'
            executable.write_text('#!/bin/sh\nexit 99\n')
            executable.chmod(0o700)
            lifecycle.require_executable(str(executable), 'NODE')
            for invalid in ('relative/tool', str(Path(temp)), str(Path(temp) / 'missing')):
                with self.subTest(path=invalid), self.assertRaisesRegex(ValueError, 'NODE_EXECUTABLE_REQUIRED'):
                    lifecycle.require_executable(invalid, 'NODE')
            executable.chmod(0o600)
            with self.assertRaisesRegex(ValueError, 'CLIENT_EXECUTABLE_REQUIRED'):
                lifecycle.require_executable(str(executable), 'CLIENT')

    def test_supervisor_entries_use_selected_home_cwd_and_environment(self):
        import datetime
        import json
        import subprocess
        import sys
        for tool in ('ce-ovis-desktop','ce-chatgpt-wake'):
            with self.subTest(tool=tool), tempfile.TemporaryDirectory() as temp:
                root=Path(temp);run=root/'run';run.mkdir();home=root/'other-home';home.mkdir()
                peer=root/'renamed node'
                peer.write_text('#!'+sys.executable+'\n'+'''import json,os,pathlib,sys,time
c=json.loads(pathlib.Path(sys.argv[-1]).read_text());r=pathlib.Path(c['runDirectory'])
(r/'observed.json').write_text(json.dumps({'cwd':str(pathlib.Path.cwd()),'home':os.environ['HOME'],'ce':{k:v for k,v in os.environ.items() if k.startswith('CE_')}}))
(r/'peer-ready.json').write_text('{}')
(r/'peer-failure.json').write_text('{}')
''')
                peer.chmod(0o700)
                desktop=root/'desktop.json';desktop.write_text(json.dumps({'desktopTmpDir':str(root/'ax'),'agentDesktop':sys.executable}))
                cfg=root/'config.json';cfg.write_text(json.dumps({'runDirectory':str(run),'isolatedHome':str(home),'node':str(peer),'client':sys.executable,'desktopConfig':str(desktop),'deadline':(datetime.datetime.now(datetime.UTC)+datetime.timedelta(seconds=15)).isoformat()}))
                supervisor=Path(__file__).resolve().parents[1]/tool/'supervise.py'
                runner=('import runpy,subprocess,sys,pathlib;from unittest.mock import patch;'
                        'sys.path.insert(0,str(pathlib.Path(sys.argv[1]).parent));original=subprocess.check_output;'
                        'inventory=lambda args,*a,**k:"" if args==["/bin/ps","-axo","pid=,command="] else original(args,*a,**k);'
                        'guard=patch("subprocess.check_output",side_effect=inventory);guard.start();sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name="__main__")')
                env={**os.environ,'HOME':str(root),'CE_ALLOWLIST':'/missing-old-policy','CE_STORE_DIR':'/missing-old-store','CE_TUNNEL_OFFLINE_TEST':'1'}
                result=subprocess.run([sys.executable,'-c',runner,str(supervisor),str(cfg)],cwd=root,env=env,capture_output=True,text=True,timeout=20)
                self.assertEqual(result.returncode,0,result.stderr)
                observed=json.loads((run/'observed.json').read_text())
                self.assertEqual(observed,{'cwd':str(run.resolve()),'home':str(home),'ce':{'CE_TUNNEL_PROFILE':str(run/'tunnel.yaml'),'CE_TUNNEL_CLIENT_PATH':sys.executable}})
                status=json.loads((run/'supervisor.json').read_text());self.assertTrue(status['peerGroupStopped']);self.assertTrue(status['desktopHostsStopped'])
                self.assertEqual(lifecycle.group_members(status['peerPid']),[])
    def test_desktop_dependency_missing_fails_before_namespace_creation(self):
        import sys
        sys.path.insert(0,str(Path(__file__).parent))
        from bridge import DesktopCli
        with tempfile.TemporaryDirectory() as temp:
            namespace=Path(temp)/'not-created'
            with self.assertRaisesRegex(ValueError,'DESKTOP_EXECUTABLE_REQUIRED'):
                DesktopCli({'agentDesktop':str(Path(temp)/'absent'),'desktopTmpDir':str(namespace),'stateDir':temp})
            self.assertFalse(namespace.exists())


if __name__ == '__main__':
    unittest.main()
