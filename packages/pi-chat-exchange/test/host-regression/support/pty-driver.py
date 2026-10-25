#!/usr/bin/env python3
"""Generic PTY driver for the opt-in real-host regression lane.

Runs the REAL Pi CLI on a REAL pseudo-terminal. Every launch's exact argv, env
and cwd arrive inside the control file, so the precise invocation is preserved
as evidence next to the raw terminal stream. The driver has no CE knowledge and
never opens the Store: it only shuttles bytes and records them.

Protocol (control files in <root>/raw, consumed in sorted order):
  {"op":"launch","name":..,"argv":[..],"env":{..},"cwd":..}
  {"op":"send","text":..}
  {"op":"kill"}                      -> SIGKILL the live child, wait, record
  {"op":"snapshot"}                  -> flush + return {pid, exit, tail}
  {"op":"stop"}                      -> flush and exit the driver

Each op's answer lands in raw/result-control-NNN.json; each launch's raw bytes,
ANSI-stripped text and metadata land in raw/<name>.{raw,txt,meta.json}.
"""
from __future__ import annotations

import fcntl
import json
import os
import pathlib
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import time

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
    (raw / f"result-{stem}.json").write_text(json.dumps(result))


lastFlush = 0.0
while True:
    live = child is not None and child.poll() is None and master >= 0
    if live and select.select([master], [], [], 0.05)[0]:
        try:
            chunk = os.read(master, 65536)
        except OSError:
            chunk = b""
        data += chunk
        # A TUI asking for the cursor position must get an answer.
        if b"\x1b[6n" in chunk:
            os.write(master, b"\x1b[1;1R")
    # The orchestrator polls <name>.txt, so the live stream must be flushed
    # continuously, not only when a control file arrives.
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
            name = command["name"]
            data = b""
            master, replica = pty.openpty()
            fcntl.ioctl(replica, termios.TIOCSWINSZ, struct.pack("HHHH", 48, 200, 0, 0))
            child = subprocess.Popen(
                command["argv"],
                cwd=command["cwd"],
                env=command["env"],
                stdin=replica,
                stdout=replica,
                stderr=replica,
                start_new_session=True,
            )
            os.close(replica)
            meta = {
                "argv": command["argv"],
                "env": command["env"],
                "cwd": command["cwd"],
                "pid": child.pid,
                "actions": [],
                "startedAt": time.time(),
            }
            result = {"pid": child.pid}
        elif op == "send":
            if child is None or child.poll() is not None or master < 0:
                raise SystemExit("send requested without a live process")
            os.write(master, command["text"].encode())
            meta["actions"].append({"time": time.time(), "send": command["text"]})
        elif op == "kill":
            if child is None:
                raise SystemExit("kill requested without a process")
            child.kill()
            child.wait(30)
            meta["actions"].append({"SIGKILL": child.pid, "exit": child.returncode, "time": time.time()})
            save()
            result = {"pid": child.pid, "exit": child.returncode}
        elif op == "snapshot":
            save()
            result = {"pid": child.pid if child else None, "exit": child.poll() if child else None,
                      "tail": clean(data)[-4000:], "at": time.time()}
        elif op == "stop":
            save()
            answer(control.stem, {"stopped": True})
            raise SystemExit(0)
        else:
            raise SystemExit(f"unknown op {op}")
        save()
        answer(control.stem, result)
    time.sleep(0.05)
