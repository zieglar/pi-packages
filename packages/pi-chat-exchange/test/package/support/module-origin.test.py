"""Exercise the actual verifier against CJS, URL and symlink origin escapes."""
import ast
import builtins
import json
import pathlib
import sys
import tempfile
import unittest
import urllib.parse
from types import CodeType, FunctionType

SOURCE = pathlib.Path(sys.argv.pop()) if len(sys.argv) == 2 else pathlib.Path(__file__).with_name('installed-host.py')


class OriginTest(unittest.TestCase):
    def test_refuses_cjs_url_and_realpath_escape(self):
        function = next(node for node in ast.parse(SOURCE.read_text()).body
                        if isinstance(node, ast.FunctionDef) and node.name == 'verify_module_origin')
        compiled = compile(ast.Module(body=[function], type_ignores=[]), '<actual-origin-verifier>', 'exec')
        code = next(value for value in compiled.co_consts if isinstance(value, CodeType))
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'run').mkdir()
            (root / 'host').mkdir()
            inside = root / 'host/owned.js'
            inside.write_text('owned fixture')
            outside = root / 'unapproved.js'
            outside.write_text('unapproved fixture')
            link = root / 'host/borrowed.js'
            link.symlink_to(outside)
            namespace = {'__builtins__': vars(builtins), 'r': root, 'node': root / 'bin/node', 'json': json, 'pathlib': pathlib, 'urllib': urllib}
            verify = FunctionType(code, namespace)
            control = [{'resolved': inside.as_uri()}] * 500
            trace = root / 'run/module-resolution.jsonl'
            trace.write_text('\n'.join(map(json.dumps, control)))
            verify()
            for escape in [str(outside), outside.as_uri(), str(link)]:
                with self.subTest(escape=escape):
                    trace.write_text('\n'.join(map(json.dumps, control + [{'resolved': escape}])))
                    with self.assertRaises(RuntimeError):
                        verify()


if __name__ == '__main__':
    unittest.main()
