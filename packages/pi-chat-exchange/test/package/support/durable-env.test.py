"""Actual verify_durable launch with synthetic poisoned caller env/cwd.
Four real Python children and copied approved Node probes; no UI/network/client.
The store mode invokes the checked-in read-only Store verifier, instrumenting
only its Node argv to record actual environment and mkdtemp destinations.
"""
import ast
import builtins
import importlib.util
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from types import CodeType, FunctionType
from unittest.mock import patch

NODE_SOURCE = pathlib.Path(sys.argv.pop()).resolve(strict=True)
SUPPORT = pathlib.Path(__file__).resolve().parent


class DurableEnvironmentTest(unittest.TestCase):
    maxDiff = None

    def test_private_environment_cwd_and_store_copy(self):
        source = (SUPPORT / 'installed-host.py').read_text()
        function = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == 'verify_durable')
        compiled = compile(ast.Module(body=[function], type_ignores=[]), '<actual-verify-durable>', 'exec')
        code = next(c for c in compiled.co_consts if isinstance(c, CodeType))
        with tempfile.TemporaryDirectory(prefix='ce-durable-env-') as directory:
            root = pathlib.Path(directory)
            for name in ['bin', 'home', 'tmp', 'run/profile/.ce-bindings', 'support', 'parent/home', 'parent/tmp', 'parent/cwd']:
                (root / name).mkdir(parents=True)
            node = root / 'bin/node'
            shutil.copy2(NODE_SOURCE, node)
            private_env = {'PATH': str(root / 'bin') + ':/usr/bin:/bin', 'HOME': str(root / 'home'),
                           'TMPDIR': str(root / 'tmp') + '/', 'LC_ALL': 'C',
                           'PI_CODING_AGENT_DIR': str(root / 'agent'),
                           'XDG_CONFIG_HOME': str(root / 'xdg/config')}
            # Explicit test-only preload records observations, never inherited
            # NODE_OPTIONS or any user preload. It does not change env/cwd/tmp.
            preload = root / 'probe.cjs'
            preload.write_text("const fs=require('node:fs'),os=require('node:os');"
                               + "const log=x=>fs.appendFileSync(" + json.dumps(str(root / 'node.jsonl')) + ",JSON.stringify(x)+'\\n');"
                               + "log({env:process.env,cwd:process.cwd(),tmp:os.tmpdir()});"
                               + "const mk=fs.mkdtempSync;fs.mkdtempSync=(...a)=>{const p=mk(...a);log({copy:p});return p};")
            # Synthetic child adapter records its own env/cwd, then launches
            # actual Node. Store mode additionally runs real verify_store code.
            adapter = root / 'support/durable_state.py'
            adapter.write_text('''import importlib.util,json,os,pathlib,subprocess,sys
root=pathlib.Path(__file__).resolve().parent.parent
mode=sys.argv[1]; facts=json.loads(pathlib.Path(sys.argv[2]).read_text())
(root/('child-'+mode+'.json')).write_text(json.dumps({'env':dict(os.environ),'cwd':os.getcwd()}))
spec=importlib.util.spec_from_file_location('actual_durable', ''' + repr(str(SUPPORT / 'durable_state.py')) + ''')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
original=subprocess.run
def traced(argv,*args,**kwargs):
    return original([argv[0],'--require',str(root/'probe.cjs'),*argv[1:]],*args,**kwargs)
module.subprocess.run=traced
if mode=='store':
    module.verify_store(facts)
else:
    p=traced([facts['nodePath'],'-e',''],capture_output=True,text=True)
    if p.returncode: raise RuntimeError(p.stderr)
''')
            spec = importlib.util.spec_from_file_location('store_fixture', SUPPORT / 'durable_state.py')
            assert spec is not None and spec.loader is not None
            durable = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(durable)
            store = root / 'run/profile/.ce-bindings/ce-store.sqlite'
            setup = "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);for(const t of " + json.dumps(sorted(durable.REQUIRED_STORE_TABLES)) + ")db.exec('CREATE TABLE '+t+' (id INTEGER)');db.close();"
            subprocess.run([str(node), '-e', setup, str(store)], env=private_env, cwd=root / 'run', check=True, capture_output=True)
            store.chmod(0o600)
            parent_sentinel = root / 'parent/tmp/keep'
            parent_sentinel.write_text('unrelated synthetic parent temp')
            poison = {'HOME': str(root / 'parent/home'), 'TMPDIR': str(root / 'parent/tmp') + '/',
                      'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'NODE_OPTIONS': '--no-warnings',
                      'OPENAI_API_KEY': 'synthetic-provider-sentinel-not-a-key',
                      'CE_ENV_SENTINEL': 'synthetic-ce-only', 'CE_TUNNEL_PROFILE': str(root / 'parent/missing.yaml')}
            # /usr/bin/python3 is an Xcode shim on macOS: observe a clean
            # control rather than misclassify its fixed SDK variables as leaks.
            control = subprocess.run(['/usr/bin/python3', '-B', '-c', 'import json,os;print(json.dumps(dict(os.environ)))'], env=private_env, cwd=root / 'run', check=True, capture_output=True, text=True)
            child_env = json.loads(control.stdout)
            self.assertEqual({k: child_env[k] for k in private_env}, private_env)
            self.assertLessEqual(set(child_env) - set(private_env), {'__CF_USER_TEXT_ENCODING', 'SDKROOT', 'CPATH', 'LIBRARY_PATH', 'MANPATH'})
            launches = []
            class Launcher:
                @staticmethod
                def run(argv, **kwargs):
                    launches.append((kwargs.get('env'), kwargs.get('cwd')))
                    return subprocess.run(argv, **kwargs)  # observe only, no argument changes
            namespace = {'__builtins__': vars(builtins), '__file__': str(root / 'support/installed-host.py'),
                         'pathlib': pathlib, 'json': json, 're': re, 'subprocess': Launcher,
                         'r': root, 'node': node, 'env': private_env, 'sandbox': [],
                         'package': root / 'consumer/package',
                         'text': lambda: 'Register ONLY current trusted Pi Session 01234567-89ab-7cde-8f01-234567890abc'}
            previous_cwd = pathlib.Path.cwd()
            try:
                os.chdir(root / 'parent/cwd')
                with patch.dict(os.environ, poison, clear=True):
                    # Only the trusted checked-in function body, never input code.
                    FunctionType(code, namespace)()
            finally:
                os.chdir(previous_cwd)
            self.assertEqual(len(launches), 4)
            for index, launch in enumerate(launches):
                with self.subTest(launch=index):
                    self.assertEqual(launch, (private_env, root / 'run'))
            for mode in ['profile', 'policy', 'mutex', 'store']:
                observed = json.loads((root / ('child-' + mode + '.json')).read_text())
                with self.subTest(child=mode):
                    self.assertEqual(observed, {'env': child_env, 'cwd': str(root / 'run')})
            records = [json.loads(line) for line in (root / 'node.jsonl').read_text().splitlines()]
            probes = [r for r in records if 'env' in r]
            self.assertEqual(len(probes), 4)
            for index, observed in enumerate(probes):
                with self.subTest(node=index):
                    self.assertEqual(observed, {'env': child_env, 'cwd': str(root / 'run'), 'tmp': str(root / 'tmp')})
            copies = [pathlib.Path(r['copy']) for r in records if 'copy' in r]
            self.assertEqual(len(copies), 1)
            with self.subTest(store_copy='private TMPDIR'):
                self.assertEqual(copies[0].parent, root / 'tmp')
            self.assertFalse(copies[0].exists(), 'real Store probe must remove its own copy')
            self.assertEqual(list((root / 'tmp').iterdir()), [])
            self.assertEqual(list((root / 'parent/tmp').iterdir()), [parent_sentinel])
            self.assertEqual(parent_sentinel.read_text(), 'unrelated synthetic parent temp')


if __name__ == '__main__':
    unittest.main()
