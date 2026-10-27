"""Exercise the actual verifier against CJS, URL, symlink and managed-root escapes."""
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


def origin_fixture(raw_root, managed):
    """Bind the ACTUAL verify_module_origin to an owned fixture namespace.

    The fixture root is CANONICALIZED because the real function resolves every
    traced path strictly before comparing it against allowed roots built from
    `r`. An unresolved root (the shape a symlinked TMPDIR produces) would make
    the 500-record positive control reject itself instead of exercising the real
    escape predicate. The returned root is the canonical one the caller must
    create fixture files under.
    """
    root = pathlib.Path(raw_root).resolve()
    function = next(node for node in ast.parse(SOURCE.read_text()).body
                    if isinstance(node, ast.FunctionDef) and node.name == 'verify_module_origin')
    compiled = compile(ast.Module(body=[function], type_ignores=[]), '<actual-origin-verifier>', 'exec')
    code = next(value for value in compiled.co_consts if isinstance(value, CodeType))
    namespace = {'__builtins__': vars(builtins), 'r': root, 'node': root / 'bin/node', 'managed': managed,
                 'json': json, 'pathlib': pathlib, 'urllib': urllib}
    return FunctionType(code, namespace), root


def write_trace(root, records):
    trace = root / 'run/module-resolution.jsonl'
    trace.write_text('\n'.join(map(json.dumps, records)))
    return trace


class OriginTest(unittest.TestCase):
    def build(self, directory, managed=False):
        verify, root = origin_fixture(directory, managed)
        for name in ['run', 'host', 'agent/npm']:
            (root / name).mkdir(parents=True, exist_ok=True)
        return verify, root

    def test_refuses_cjs_url_and_realpath_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            verify, root = self.build(directory)
            inside = root / 'host/owned.js'
            inside.write_text('owned fixture')
            outside = root / 'unapproved.js'
            outside.write_text('unapproved fixture')
            link = root / 'host/borrowed.js'
            link.symlink_to(outside)
            control = [{'resolved': inside.as_uri()}] * 500
            write_trace(root, control)
            verify()
            for escape in [str(outside), outside.as_uri(), str(link)]:
                with self.subTest(escape=escape):
                    write_trace(root, control + [{'resolved': escape}])
                    with self.assertRaises(RuntimeError):
                        verify()

    def test_managed_npm_root_is_allowed_only_in_managed_mode(self):
        """The managed tree is a real positive origin under managed npm, and a
        real escape under the tarball route's strict consumer/host allowlist."""
        with tempfile.TemporaryDirectory() as directory:
            verify_managed, root = self.build(directory, managed=True)
            installed = root / 'agent/npm/node_modules/@zieglar/pi-chat-exchange/dist/index.js'
            installed.parent.mkdir(parents=True)
            installed.write_text('managed fixture')
            control = [{'resolved': installed.as_uri()}] * 500
            write_trace(root, control)
            verify_managed()
            verify_tarball, _ = origin_fixture(directory, False)
            with self.assertRaises(RuntimeError):
                verify_tarball()

    def test_positive_control_survives_a_symlinked_temp_root(self):
        """Regression for an owned LINKED temp root: an unresolved fixture root
        rejected all 500 of its own positive-control records."""
        with tempfile.TemporaryDirectory() as directory:
            outer = pathlib.Path(directory).resolve()
            (outer / 'real').mkdir()
            (outer / 'link').symlink_to(outer / 'real')
            staged = outer / 'link/stage'
            staged.mkdir()
            verify, root = self.build(staged)
            self.assertNotEqual(str(root), str(staged))
            self.assertTrue(root.is_relative_to(outer / 'real'))
            inside = root / 'host/owned.js'
            inside.write_text('owned fixture')
            control = [{'resolved': inside.as_uri()}] * 500
            write_trace(root, control)
            verify()
            outside = outer / 'real/escape.js'
            outside.write_text('unapproved fixture')
            write_trace(root, control + [{'resolved': str(outside)}])
            with self.assertRaises(RuntimeError):
                verify()


if __name__ == '__main__':
    unittest.main()
