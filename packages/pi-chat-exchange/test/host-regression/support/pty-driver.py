#!/usr/bin/env python3
"""Owned PTY driver for the opt-in real-host regression lane.

Protocol in <root>/raw: launch (argv/env/cwd/name), send (text), kill,
snapshot, stop. Each response is result-control-NNN.json. Terminal bytes,
ANSI-stripped text and launch/cleanup metadata remain beside the controls.
Stop and every exception explicitly terminate, wait/reap and close the PTY;
only the session/process group created by this driver may be signalled.
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
from contextlib import suppress

root = pathlib.Path(sys.argv[1])
raw = root / "raw"
raw.mkdir(parents=True, exist_ok=True)
ansi = re.compile(
    rb'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()#][0-9A-Za-z]|[\x00\x07\x0e\x0f]'
)


def clean(buffer: bytes) -> str:
    return ansi.sub(b"", buffer).decode("utf8", "replace")


child: subprocess.Popen | None = None
master = -1
replica = -1
data = b""
name = ""
meta: dict = {}
seen: set = set()


def save() -> None:
    if not name:
        return
    (raw / f"{name}.raw").write_bytes(data)
    (raw / f"{name}.txt").write_text(clean(data))
    meta["exit"] = child.poll() if child is not None else None
    meta["capturedAt"] = time.time()
    (raw / f"{name}.meta.json").write_text(json.dumps(meta, indent=2))


def answer(stem: str, result: dict) -> None:
    # Publish atomically: the parent polls from another process.
    destination = raw / f"result-{stem}.json"
    temporary = destination.with_suffix(".tmp")
    temporary.write_text(json.dumps(result))
    temporary.replace(destination)


def cleanup() -> None:
    global master, replica
    try:
        if child is not None:
            if child.poll() is None:
                # start_new_session makes child.pid the owned group ID.
                with suppress(ProcessLookupError):
                    os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    with suppress(ProcessLookupError):
                        os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=3)
            else:
                child.wait(timeout=3)  # idempotent after intentional SIGKILL
            meta["cleanup"] = {"pid": child.pid, "reaped": True, "exit": child.returncode}
    finally:
        for fd in (master, replica):
            if fd >= 0:
                os.close(fd)
        master = replica = -1
    save()


def interrupted(signum, _frame) -> None:
    raise SystemExit(f"driver interrupted by signal {signum}")


signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
lastFlush = 0.0
try:
    while True:
        live = child is not None and child.poll() is None and master >= 0
        if live and select.select([master], [], [], 0.05)[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                chunk = b""
            data += chunk
            if b"\x1b[6n" in chunk:
                os.write(master, b"\x1b[1;1R")
        if name and time.time() - lastFlush > 0.2:
            lastFlush = time.time()
            save()
        for control in sorted(raw.glob("control-*.json")):
            if control.name in seen:
                continue
            seen.add(control.name)
            command = json.loads(control.read_text())
            op = command["op"]
            result: dict = {}
            if op == "launch":
                if child is not None and child.poll() is None:
                    raise SystemExit("launch requested while a process is live")
                cleanup()
                name = command["name"]
                data = b""
                master, replica = pty.openpty()
                fcntl.ioctl(replica, termios.TIOCSWINSZ, struct.pack("HHHH", 48, 200, 0, 0))
                child = subprocess.Popen(
                    command["argv"], cwd=command["cwd"], env=command["env"],
                    stdin=replica, stdout=replica, stderr=replica,
                    start_new_session=True,
                )
                os.close(replica)
                replica = -1
                meta = {"argv": command["argv"], "env": command["env"], "cwd": command["cwd"],
                        "pid": child.pid, "actions": [], "startedAt": time.time()}
                result = {"pid": child.pid}
            elif op == "send":
                if child is None or child.poll() is not None or master < 0:
                    raise SystemExit("send requested without a live process")
                os.write(master, command["text"].encode())
                meta["actions"].append({"time": time.time(), "send": command["text"]})
            elif op == "kill":
                if child is None:
                    raise SystemExit("kill requested without a process")
                if child.poll() is None:
                    child.kill()
                child.wait(3)
                meta["actions"].append({"SIGKILL": child.pid, "exit": child.returncode, "time": time.time()})
                result = {"pid": child.pid, "exit": child.returncode}
            elif op == "snapshot":
                save()
                result = {"pid": child.pid if child else None, "exit": child.poll() if child else None,
                          "tail": clean(data)[-4000:], "at": time.time()}
            elif op == "stop":
                cleanup()
                answer(control.stem, {"stopped": True})
                raise SystemExit(0)
            else:
                raise SystemExit(f"unknown op {op}")
            save()
            answer(control.stem, result)
        time.sleep(0.05)
finally:
    cleanup()
