#!/usr/bin/env python3
"""Synthetic cooperative/non-escaping workload supervisor, not a containment API.

The Node parent owns driver AND guardian handles. Only driver owns the write end
of fd 3; guardian reads EOF, anchor/Pi never inherit it (close_fds=True).
Guardian owns an unreaped anchor; anchor owns/reaps actual Pi. No saved identity
is signalled after anchor reap. Explicit modes keep all roles in this test file.
"""
from __future__ import annotations

import fcntl
import json
import os
import pathlib
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time
import uuid
from contextlib import suppress


def publish(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2))
    temporary.replace(path)


def load(path):
    return json.loads(path.read_text())


def wait_file(path, timeout=10):
    deadline = time.monotonic() + timeout
    while not path.exists():
        if time.monotonic() >= deadline:
            raise TimeoutError('missing supervision evidence: ' + str(path))
        time.sleep(.01)
    return load(path)


INSPECTION_QUERY = ['/bin/ps', '-axo', 'pid=,ppid=,pgid=,stat=']
evidence_root: pathlib.Path | None = None  # private per-launch evidence directory


def record_inspection(pgid, result, reason, detail):
    """DIAGNOSTIC-ONLY raw record. Refusal semantics are deliberately unchanged:
    the caller still raises, so no relaxed parsing or filtering happens here.
    The query selects numeric identity/state fields only: no command lines.
    """
    if evidence_root is None:
        return
    document = {'argv': INSPECTION_QUERY, 'pgid': pgid, 'reason': reason, 'detail': detail,
                'returncode': getattr(result, 'returncode', None),
                'stdout': getattr(result, 'stdout', None), 'stderr': getattr(result, 'stderr', None),
                'at': time.time(), 'recorderPid': os.getpid()}
    path = evidence_root / f'inspection-failure-{os.getpid()}-{time.time_ns()}.json'
    # Evidence recording must never weaken or replace the refusal.
    with suppress(OSError):
        publish(path, document)


def members(pgid, inspect=None):
    """Numeric snapshot. A zombie is dead, NOT evidence of descendant reap."""
    if type(pgid) is not int or pgid <= 0:
        raise ValueError('invalid target process group')
    result = (inspect or subprocess.run)(
        INSPECTION_QUERY, capture_output=True, text=True, timeout=2, close_fds=True)
    if result.returncode != 0 or result.stderr or not result.stdout.strip():
        record_inspection(pgid, result, 'group inspection failed',
                          {'why': 'non-zero status, stderr present, or empty stdout'})
        raise RuntimeError('group inspection failed')
    rows = []
    for index, line in enumerate(result.stdout.splitlines()):
        # The installed macOS ps renders a transient state as unknown '?'
        # (observed '?', '?+', '?s', '?E'). Such a row is valid output, so it is
        # parsed rather than refused; it is NEVER classified dead or reaped, so
        # the bounded observation keeps polling and still fails closed.
        match = re.fullmatch(r'\s*(\d+)\s+(\d+)\s+(\d+)\s+([?A-Za-z+<>NsXWEILV0-9-]+)\s*', line)
        if not match:
            fields = line.split()
            record_inspection(pgid, result, 'malformed group inspection',
                              {'lineIndex': index, 'line': repr(line), 'fieldCount': len(fields),
                               'fields': fields[:4], 'why': 'row did not match the strict numeric identity/state row'})
            raise ValueError('malformed group inspection')
        pid, ppid, group = map(int, match.groups()[:3])
        # Linux kernel threads legitimately have PGID 0. Parse these strictly,
        # but they cannot belong to our already validated positive anchor PGID.
        if pid <= 0:
            record_inspection(pgid, result, 'invalid process identity',
                              {'lineIndex': index, 'line': repr(line), 'why': 'pid was not positive'})
            raise ValueError('invalid process identity')
        if group == pgid:
            rows.append({'pid': pid, 'ppid': ppid, 'pgid': group,
                         'state': match[4], 'dead': match[4].startswith('Z'), 'reaped': False})
    return rows


def final_barrier(anchor, inspect=None, send=os.killpg, clock=time.monotonic, pause=time.sleep):
    """The only final group signal. Anchor is never polled/waited before it.

    Adapter arguments exercise the real ordering/error path, not a second model.
    Even failed inspection reaps the anchor last, but cannot authorize offline.
    """
    inspect = inspect or members
    outcome = {'groupDead': False, 'events': [], 'members': []}
    try:
        send(anchor.pid, signal.SIGKILL)
        outcome['events'].append('final-group-kill')
        deadline = clock() + 3
        while True:
            rows = inspect(anchor.pid)
            outcome['members'] = rows
            if not any(not row['dead'] for row in rows):
                outcome['groupDead'] = True
                outcome['events'].append('no-live-members')
                break
            if clock() >= deadline:
                raise TimeoutError('group death inspection timed out')
            pause(.02)
    except Exception as error:
        outcome['error'] = str(error)
    finally:
        try:
            outcome['anchorExit'] = anchor.wait(timeout=3)
            outcome['events'].append('anchor-reaped')
            outcome['anchorReaped'] = True
        except Exception as error:
            outcome['error'] = str(error)
            outcome['anchorReaped'] = False
    return outcome


def anchor_mode(raw, generation):
    command = load(raw / ('launch-' + generation + '.json'))
    # A caught handler is reset on exec; Pi receives normal TERM semantics.
    signal.signal(signal.SIGTERM, lambda *_: None)
    child = subprocess.Popen(command['argv'], cwd=command['cwd'], env=command['env'],
                             close_fds=True)
    actual_group = os.getpgid(child.pid)  # still-owned, never polled/reaped yet
    if actual_group != os.getpgrp():
        raise RuntimeError('actual Pi escaped anchor group')
    publish(raw / ('actual-' + generation + '.json'), {'pid': child.pid, 'anchorPid': os.getpid(),
            'pgid': actual_group, 'generation': generation})
    exited = False
    while True:
        if not exited:
            if (raw / ('kill-' + generation)).exists() and child.poll() is None:
                child.kill()  # actual, still-owned Pi handle, never a saved PID
            status = child.poll()
            if status is not None:
                child.wait()
                publish(raw / ('exit-' + generation + '.json'), {'pid': child.pid, 'exit': status,
                        'generation': generation, 'reaped': True})
                exited = True
        time.sleep(.01)  # anchor lifetime ends ONLY at guardian's final group kill


def guardian_mode(raw):
    anchor = None
    command = None
    actual = None
    barrier = None
    generation = None
    seen = set()
    driver_lost = False

    def alive_driver():
        nonlocal driver_lost
        if select.select([3], [], [], 0)[0] and os.read(3, 1) == b'':
            driver_lost = True
        return not driver_lost

    def actual_exit(timeout):
        assert generation is not None and actual is not None
        deadline = time.monotonic() + timeout
        path = raw / ('exit-' + generation + '.json')
        while not path.exists():
            alive_driver()
            if time.monotonic() >= deadline:
                raise TimeoutError('actual Pi exit not confirmed')
            time.sleep(.01)
        result = load(path)
        if result.get('generation') != generation or result.get('pid') != actual['pid'] or not result.get('reaped'):
            raise ValueError('actual Pi exit identity mismatch')
        return result

    def cleanup():
        nonlocal barrier
        if anchor is None or barrier is not None:
            return barrier
        assert generation is not None and command is not None
        # Never poll/wait anchor here. Its live-or-zombie lifetime pins PGID.
        os.killpg(anchor.pid, signal.SIGTERM)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            alive_driver()
            time.sleep(.01)
        # The anchor must reap actual Pi BEFORE the final group signal.
        (raw / ('kill-' + generation)).touch()
        error = None
        try:
            ended = actual_exit(3)
        except Exception as failure:
            error = str(failure)
            ended = {'exit': None, 'reaped': False}
        outcome = final_barrier(anchor)
        barrier = {'name': command['name'], 'pid': actual['pid'] if actual else None, 'generation': generation,
                   'anchorPid': anchor.pid, 'pgid': anchor.pid, 'startedAt': command['startedAt'],
                   'exit': ended['exit'], 'reaped': ended['reaped'], **outcome,
                   'driverLost': driver_lost, 'guardianPid': os.getpid()}
        if error:
            barrier['error'] = error
        barrier['confirmed'] = (barrier['groupDead'] and barrier['anchorReaped'] and barrier['reaped']
                                and not driver_lost and 'error' not in barrier)
        publish(raw / ('barrier-' + generation + '.json'), barrier)
        return barrier

    successful = False
    try:
        while alive_driver():
            for path in sorted(raw.glob('guardian-control-*.json')):
                if path.name in seen:
                    continue
                seen.add(path.name)
                request = load(path)
                op = request['op']
                result = {}
                if op == 'launch':
                    if anchor is not None and barrier is None:
                        raise RuntimeError('replacement launch without group barrier')
                    generation = request['generation']
                    command = request
                    barrier = None
                    # The predecessor anchor's ownership ended at its confirmed
                    # barrier reap, and a reaped PGID may already be reused by an
                    # unrelated group. Drop both saved references BEFORE any
                    # fallible replacement setup, so a failed slave open or anchor
                    # spawn leaves finally-cleanup nothing stale to signal.
                    anchor = None
                    actual = None
                    slave = os.open(request['slave'], os.O_RDWR)
                    try:
                        anchor = subprocess.Popen([sys.executable, __file__, '--anchor', str(raw.parent), generation],
                            stdin=slave, stdout=slave, stderr=slave, start_new_session=True, close_fds=True)
                    finally:
                        os.close(slave)
                    actual = wait_file(raw / ('actual-' + generation + '.json'))
                    if actual['anchorPid'] != anchor.pid or actual['pgid'] != anchor.pid:
                        raise RuntimeError('anchor group identity mismatch')
                    result = actual
                elif op == 'kill':
                    assert generation is not None
                    (raw / ('kill-' + generation)).touch()
                    actual_exit(3)
                    result = cleanup()
                elif op == 'cleanup':
                    result = cleanup() or {}
                elif op == 'offline':
                    if (generation is None or not barrier or not barrier['confirmed'] or driver_lost
                            or request.get('generation') != generation
                            or not (raw / ('barrier-' + generation + '.json')).exists()
                            or load(raw / ('barrier-' + generation + '.json')) != barrier):
                        result = {'error': 'offline group/guardian confirmation missing or mismatched'}
                    else:
                        result = barrier
                elif op == 'stop':
                    result = cleanup() or {}
                    successful = anchor is None or bool(result.get('confirmed'))
                    publish(raw / ('guardian-result-' + path.stem + '.json'), result)
                    return
                else:
                    raise ValueError('unknown guardian control')
                publish(raw / ('guardian-result-' + path.stem + '.json'), result)
            time.sleep(.01)
    finally:
        # A cleanup failure here must neither hide the original cause nor skip
        # the guardian-outcome evidence: capture the in-flight exception first,
        # keep the last barrier, and publish an explicitly unsuccessful outcome
        # with distinct error fields. The run stays fail-closed either way.
        failure = sys.exc_info()[1]
        result = barrier
        cleanup_error = None
        try:
            result = cleanup()
        except Exception as error:
            cleanup_error = str(error)
            result = barrier
        outcome = {'successful': successful and not driver_lost and failure is None and cleanup_error is None,
                'driverLost': driver_lost, 'barrier': result, 'guardianPid': os.getpid()}
        if failure is not None:
            outcome['error'] = str(failure)
        if cleanup_error is not None:
            outcome['cleanupError'] = cleanup_error
        try:
            publish(raw / 'guardian-outcome.json', outcome)
        except OSError as error:
            # Best-effort only: a failed write (e.g. disk full) must not mask
            # the original failure, and the missing outcome stays fail-closed
            # for the parent. Bounded diagnostic, no unrelated fields.
            sys.stderr.write(f'guardian outcome publication failed: {error}\n')


def driver_mode(raw):
    master = replica = -1
    data = b''
    name = ''
    meta = {}
    generation = None
    sequence = 0
    seen = set()
    ansi = re.compile(rb'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()#][0-9A-Za-z]|[\x00\x07\x0e\x0f]')

    def clean():
        return ansi.sub(b'', data).decode('utf8', 'replace')

    def ended():
        path = raw / ('exit-' + str(generation) + '.json')
        return load(path)['exit'] if generation and path.exists() else None

    def save():
        if name:
            (raw / (name + '.raw')).write_bytes(data)
            (raw / (name + '.txt')).write_text(clean())
            meta['exit'] = ended()
            meta['capturedAt'] = time.time()
            publish(raw / (name + '.meta.json'), meta)

    def rpc(command):
        nonlocal sequence
        sequence += 1
        stem = f'guardian-control-{sequence:06d}'
        publish(raw / (stem + '.json'), {**command, 'generation': generation})
        result = wait_file(raw / ('guardian-result-' + stem + '.json'), 12)
        return result

    def drain():
        nonlocal data
        if master >= 0 and select.select([master], [], [], .02)[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                chunk = b''
            data += chunk
            if b'\x1b[6n' in chunk:
                os.write(master, b'\x1b[1;1R')

    def cleanup():
        nonlocal master, replica
        try:
            if generation:
                result = rpc({'op': 'cleanup'})
                meta['cleanup'] = result
                if not result.get('confirmed'):
                    raise RuntimeError('group cleanup unconfirmed')
        finally:
            for fd in (master, replica):
                if fd >= 0:
                    os.close(fd)
            master = replica = -1
            save()

    def interrupted(signum, _frame):
        raise SystemExit('driver interrupted by signal ' + str(signum))

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    stopped = False
    try:
        while True:
            drain()
            save()
            for path in sorted(raw.glob('control-*.json')):
                if path.name in seen:
                    continue
                seen.add(path.name)
                command = load(path)
                op = command['op']
                result = {}
                if op == 'launch':
                    if generation and ended() is None:
                        raise RuntimeError('launch requested while a process is live')
                    cleanup()
                    name, data = command['name'], b''
                    generation = uuid.uuid4().hex
                    command['startedAt'] = time.time()
                    publish(raw / ('launch-' + generation + '.json'), command)
                    master, replica = pty.openpty()
                    fcntl.ioctl(replica, termios.TIOCSWINSZ, struct.pack('HHHH', 48, 200, 0, 0))
                    result = rpc({**command, 'slave': os.ttyname(replica)})
                    os.close(replica)
                    replica = -1
                    meta = {**command, **result, 'actions': []}
                elif op == 'send':
                    if not generation or ended() is not None or master < 0:
                        raise RuntimeError('send requested without a live process')
                    os.write(master, command['text'].encode())
                    meta['actions'].append({'time': time.time(), 'send': command['text']})
                elif op == 'kill':
                    if not generation:
                        raise RuntimeError('kill requested without a process')
                    result = rpc({'op': 'kill'})
                    meta['actions'].append({'SIGKILL': meta['pid'], 'exit': result['exit'], 'time': time.time()})
                    cleanup()
                elif op == 'await-exit':
                    timeout = command.get('timeoutMs', 15000)
                    if not isinstance(timeout, (int, float)) or not 0 < timeout <= 30000:
                        raise ValueError('await-exit timeout must be in (0, 30000]ms')
                    deadline = time.monotonic() + timeout / 1000
                    while generation and ended() is None and time.monotonic() < deadline:
                        drain()
                        time.sleep(.01)
                    if not generation or ended() is None:
                        result = {'error': 'current launch exit not confirmed: still live or absent'}
                    else:
                        cleanup()
                        result = rpc({'op': 'offline'})
                elif op == 'offline':
                    result = rpc({'op': 'offline'}) if generation else {'error': 'offline launch absent'}
                elif op == 'snapshot':
                    result = {'pid': meta.get('pid'), 'exit': ended(), 'tail': clean()[-4000:], 'at': time.time()}
                elif op == 'stop':
                    cleanup()
                    rpc({'op': 'stop'})
                    stopped = True
                    publish(raw / ('result-' + path.stem + '.json'), {'stopped': True})
                    return
                else:
                    raise ValueError('unknown op ' + op)
                save()
                publish(raw / ('result-' + path.stem + '.json'), result)
            time.sleep(.02)
    finally:
        if not stopped:
            try:
                cleanup()
            finally:
                rpc({'op': 'stop'})
        os.close(3)  # exclusive liveness writer, never inherited by workload


if __name__ == '__main__':
    mode, root = sys.argv[1:3]
    raw = pathlib.Path(root) / 'raw'
    raw.mkdir(parents=True, exist_ok=True)
    evidence_root = raw
    if mode == '--driver':
        driver_mode(raw)
    elif mode == '--guardian':
        guardian_mode(raw)
    elif mode == '--anchor':
        anchor_mode(raw, sys.argv[3])
    else:
        raise ValueError('explicit supervision mode required')
