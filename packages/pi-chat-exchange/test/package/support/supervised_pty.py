"""Reuse the committed guardian/anchor, with the *outer runner* owning liveness.
The guardian survives runner SIGKILL/timeout; only it signals its unreaped anchor.
No persisted PID or reaped PGID is ever used as signal authority here.
"""
import json
import os
import pathlib
import subprocess
import sys
import time
import uuid


class SupervisedPty:
    def __init__(self, root, argv, env, cwd, slave):
        self.raw = root / 'raw'
        self.raw.mkdir()
        self.generation = uuid.uuid4().hex
        self.sequence = 0
        self.closed = False
        driver = pathlib.Path(__file__).resolve().parents[2] / 'host-regression/support/pty-driver.py'
        bootstrap = (
            'import os,sys,importlib.util,pathlib;'
            'os.dup2(0,3);'
            's=importlib.util.spec_from_file_location("guardian",sys.argv[2]);'
            'm=importlib.util.module_from_spec(s);s.loader.exec_module(m);'
            'm.evidence_root=pathlib.Path(sys.argv[3])/"raw";m.guardian_mode(m.evidence_root)'
        )
        self.log = (root / 'guardian.log').open('wb')
        self.guardian = subprocess.Popen(
            [sys.executable, '-B', '-c', bootstrap, 'stdin-liveness', str(driver), str(root)],
            stdin=subprocess.PIPE, stdout=self.log, stderr=subprocess.STDOUT,
            # Never become a session leader: guardian opens a PTY slave during
            # launch; acquiring it as controlling terminal would kill guardian
            # with SIGHUP when the outer driver's master closes. Anchor alone
            # creates/pins the workload session, exactly as the existing driver.
            start_new_session=False, close_fds=True,
        )
        self.writer = self.guardian.stdin
        assert self.writer is not None
        command = {'op': 'launch', 'name': 'installed-host', 'argv': argv,
                   'env': env, 'cwd': str(cwd), 'slave': os.ttyname(slave),
                   'generation': self.generation, 'startedAt': time.time()}
        self.publish(self.raw / ('launch-' + self.generation + '.json'), command)
        self.actual = self.rpc(command)
        self.pid = self.actual['pid']  # diagnostic only, never signaled here

    @staticmethod
    def publish(path, value):
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(value, indent=2))
        temporary.replace(path)

    def rpc(self, command):
        self.sequence += 1
        stem = f'guardian-control-{self.sequence:06d}'
        self.publish(self.raw / (stem + '.json'), dict(command, generation=self.generation))
        result = self.raw / ('guardian-result-' + stem + '.json')
        deadline = time.monotonic() + 15
        while not result.exists():
            if self.guardian.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError('Guardian command failed: ' + str(self.raw))
            time.sleep(.02)
        return json.loads(result.read_text())

    def poll(self):
        path = self.raw / ('exit-' + self.generation + '.json')
        return json.loads(path.read_text())['exit'] if path.exists() else None

    def wait(self, timeout=10):
        deadline = time.monotonic() + timeout
        while self.poll() is None:
            if time.monotonic() > deadline:
                raise TimeoutError('Actual Host did not exit')
            time.sleep(.05)
        return self.poll()

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            result = self.rpc({'op': 'stop'})
            if not result.get('confirmed'):
                raise RuntimeError('Unconfirmed owned group cleanup')
        finally:
            assert self.writer is not None
            self.writer.close()  # even RPC failure wakes independent cleanup
            self.guardian.wait(timeout=20)
            self.log.close()
        outcome = json.loads((self.raw / 'guardian-outcome.json').read_text())
        if not outcome.get('successful'):
            raise RuntimeError('Guardian outcome not successful')
