"""Fault injection into the actual installed-host finalization control flow.
No host/process is launched: owned-handle cleanup and validators are injected.
The AST slice omits only the interactive first-run body, not finalization.
"""
import ast
import builtins
import json
import pathlib
import sys
import tempfile
import unittest
from types import CodeType, FunctionType

sys.path.insert(0, str(pathlib.Path(__file__).parent))


class FinalizationTest(unittest.TestCase):
    def exercise(self, validator_fault=False, cleanup_fault=False, identity_fault=False, native_fault=False):
        source = pathlib.Path(__file__).with_name('installed-host.py').read_text()
        tree = ast.parse(source)
        block = tree.body[-1]
        assert isinstance(block, (ast.Try, ast.With))
        # Keep the real result publication + validators; omit the PTY commands
        # that precede the successful host exit in the same protected block.
        start = next(i for i, node in enumerate(block.body)
                     if isinstance(node, ast.Expr) and
                     (isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name)
                      and node.value.func.id == 'verify_durable' or
                      'result.json' in (ast.get_source_segment(source, node) or '')))
        block.body = block.body[start:]
        function = ast.FunctionDef(name='finalize', args=ast.arguments(posonlyargs=[], args=[], kwonlyargs=[], kw_defaults=[], defaults=[]), body=[block], decorator_list=[])
        module = ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[]))
        compiled = compile(module, '<actual-installed-finalization>', 'exec')
        code = next(value for value in compiled.co_consts if isinstance(value, CodeType))
        calls = []
        def validate():
            calls.append('validator')
            if validator_fault:
                raise RuntimeError('injected validator failure')
        def native():
            calls.append('native')
            if native_fault:
                raise RuntimeError('injected native lifecycle failure')
        class Handle:
            pid = 1
            def close(self):
                calls.append('cleanup')
                if cleanup_fault:
                    raise RuntimeError('injected cleanup failure')
            def poll(self):
                return 0
        def identity(label):
            calls.append(label)
            return 'changed' if identity_fault else 'trusted'
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            namespace = {'__builtins__': vars(builtins), 'r': root, 'json': json, 'p': Handle(), 'os': type('OS', (), {'close': staticmethod(lambda fd: calls.append('fd-close'))}),
                         'master': 42, 'ps_identity': identity, 'ps_before': 'trusted', 'text': lambda: '', 'argv': [], 'actions': [],
                         'verify_durable': validate, 'verify_module_origin': lambda: calls.append('module'),
                         'verify_native_lifecycle': native, 'managed': True, 'failures': []}
            failure = None
            try:
                # Trusted checked-in harness AST only; never input or profile code.
                FunctionType(code, namespace)()
            except BaseException as error:
                failure = error
            self.assertTrue((root / 'result.json').is_file(), repr(failure))
            result = json.loads((root / 'result.json').read_text())
            if validator_fault or cleanup_fault or identity_fault or native_fault:
                self.assertIsNotNone(failure)
                self.assertNotEqual(result.get('FIRST_RUN'), 'PASS', result)
                if validator_fault:
                    self.assertIn('injected validator failure', json.dumps(result))
                if cleanup_fault:
                    self.assertIn('injected cleanup failure', json.dumps(result))
            else:
                self.assertIsNone(failure)
                self.assertEqual(result['FIRST_RUN'], 'PASS')
            self.assertIn('cleanup', calls)
            self.assertIn('ps-after', calls)

    def test_success(self):
        self.exercise()
    def test_validator_failure(self):
        self.exercise(validator_fault=True)
    def test_cleanup_failure(self):
        self.exercise(cleanup_fault=True)
    def test_both_failures_preserved(self):
        self.exercise(validator_fault=True, cleanup_fault=True)
    def test_native_failure(self):
        self.exercise(native_fault=True)
    def test_identity_failure(self):
        self.exercise(identity_fault=True)


if __name__ == '__main__':
    unittest.main()
