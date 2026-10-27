"""Ephemeral candidate-only HTTP registry, bound exclusively to owned loopback.
No upstream proxy, credentials, npm publish or write methods. Callers configure
only @zieglar to this registry; necessary dependencies use explicit npmjs HTTPS.
"""
import base64
import hashlib
import http.server
import json
import tarfile
import threading
import urllib.parse


class CandidateRegistry:
    def __init__(self, archive, log):
        self.payload = archive.read_bytes()
        with tarfile.open(archive, 'r:gz') as packed:
            member = packed.getmember('package/package.json')
            if not member.isfile() or member.size > 100_000:
                raise RuntimeError('Invalid candidate manifest')
            stream = packed.extractfile(member)
            if stream is None:
                raise RuntimeError('Missing candidate manifest')
            manifest = json.load(stream)
        if (manifest.get('name'), manifest.get('version')) != ('@zieglar/pi-chat-exchange', '0.2.0'):
            raise RuntimeError('Not the exact approved 0.2.0 candidate')
        self.log = log
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                pass

            def respond(self, code, payload, content_type):
                with owner.log.open('a') as stream:
                    stream.write(json.dumps({'method': self.command, 'path': self.path, 'status': code}) + '\n')
                self.send_response(code)
                self.send_header('Content-Type', content_type)
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_GET(self):
                path = urllib.parse.unquote(self.path)
                if path == '/@zieglar/pi-chat-exchange':
                    self.respond(200, json.dumps(owner.metadata).encode(), 'application/json')
                elif path == '/candidate-0.2.0.tgz':
                    self.respond(200, owner.payload, 'application/octet-stream')
                else:
                    self.respond(404, b'not an authorized candidate route', 'text/plain')

            def do_PUT(self):
                self.respond(405, b'publication is forbidden', 'text/plain')

            do_POST = do_PUT
            do_DELETE = do_PUT

        self.server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
        self.url = 'http://127.0.0.1:' + str(self.server.server_port)
        self.metadata = {'name': '@zieglar/pi-chat-exchange', 'dist-tags': {'latest': '0.2.0'}, 'versions': {'0.2.0': {
            **manifest,
            'dist': {'tarball': self.url + '/candidate-0.2.0.tgz',
                     'integrity': 'sha512-' + base64.b64encode(hashlib.sha512(self.payload).digest()).decode()}}}}
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        if self.thread.is_alive():
            raise RuntimeError('Owned registry did not exit')
