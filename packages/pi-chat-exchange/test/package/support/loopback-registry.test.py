"""Own loopback registry only; never publishes or proxies arbitrary packages."""
import base64
import hashlib
import http.client
import io
import json
import pathlib
import tarfile
import tempfile
import unittest
import urllib.parse

from loopback_registry import CandidateRegistry


class RegistryTest(unittest.TestCase):
    def test_exact_bytes_integrity_and_refused_routes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            archive = root / 'candidate.tgz'
            with tarfile.open(archive, 'w:gz') as packed:
                payload = json.dumps({'name': '@zieglar/pi-chat-exchange', 'version': '0.2.0', 'dependencies': {'fixture': '1.0.0'}}).encode()
                member = tarfile.TarInfo('package/package.json')
                member.size = len(payload)
                packed.addfile(member, io.BytesIO(payload))
            with CandidateRegistry(archive, root / 'requests.jsonl') as registry:
                def request(path, method='GET'):
                    url = urllib.parse.urlparse(registry.url)
                    self.assertEqual((url.scheme, url.hostname), ('http', '127.0.0.1'))
                    connection = http.client.HTTPConnection('127.0.0.1', url.port, timeout=5)
                    try:
                        connection.request(method, path)
                        response = connection.getresponse()
                        return response.status, response.read()
                    finally:
                        connection.close()
                status, data = request('/@zieglar%2fpi-chat-exchange')
                self.assertEqual(status, 200)
                metadata = json.loads(data)
                version = metadata['versions']['0.2.0']
                self.assertEqual(version['dependencies'], {'fixture': '1.0.0'})
                self.assertEqual(version['dist']['integrity'], 'sha512-' + base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode())
                self.assertTrue(version['dist']['tarball'].startswith(registry.url + '/'))
                self.assertEqual(request('/candidate-0.2.0.tgz'), (200, archive.read_bytes()))
                for path in ['/other', '/@zieglar/pi-chat-exchange/1.0.0', '/../candidate.tgz']:
                    self.assertEqual(request(path)[0], 404)
                self.assertEqual(request('/@zieglar/pi-chat-exchange', 'PUT')[0], 405)
            self.assertFalse(registry.thread.is_alive())
            self.assertIn('PUT', (root / 'requests.jsonl').read_text())


if __name__ == '__main__':
    unittest.main()
