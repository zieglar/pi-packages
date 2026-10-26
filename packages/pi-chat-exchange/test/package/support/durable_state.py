"""Durable-state verification for the installed-distribution heavy lane.

Read-only inspection of the PRIVATE synthetic fixture this lane itself created:
no signalling, no mutation, no real profile/Store/credential is ever opened.
The same predicates back the default-suite fault-detection lane
(test/package/durable-state.test.ts), so a UI-only regression cannot pass.
"""
from __future__ import annotations

import json
import os
import pathlib
import stat
import subprocess
import sys
from typing import NoReturn

REQUIRED_STORE_TABLES = frozenset({
    "store_metadata", "schema_migrations", "restore_hold", "exchange", "message",
    "attempt", "current_claim", "fencing_high_water", "result", "idempotency_record",
    "evidence_envelope", "evidence_application", "reconciliation", "disposition",
    "audit_event", "participant", "participant_capability", "participant_session",
    "exchange_membership", "participant_ownership", "participant_fencing_high_water",
    "delivery_cursor", "host_trust_root", "delivery_ack_receipt",
})


def refuse(message: str) -> NoReturn:
    raise SystemExit("durable state refused: " + message)


def lstat(path: pathlib.Path):
    try:
        return os.lstat(path)
    except OSError:
        refuse(f"missing {path}")


def regular_file(path: pathlib.Path, mode: int) -> str:
    st = lstat(path)
    if not stat.S_ISREG(st.st_mode):
        refuse(f"not a regular file: {path}")
    if st.st_uid != os.geteuid():
        refuse(f"foreign owner: {path}")
    if stat.S_IMODE(st.st_mode) != mode:
        refuse(f"mode {oct(stat.S_IMODE(st.st_mode))} != {oct(mode)}: {path}")
    return path.read_text()


def regular_mode(path: pathlib.Path, mode: int) -> None:
    st = lstat(path)
    if not stat.S_ISREG(st.st_mode):
        refuse(f"not a regular file: {path}")
    if st.st_uid != os.geteuid():
        refuse(f"foreign owner: {path}")
    if stat.S_IMODE(st.st_mode) != mode:
        refuse(f"mode {oct(stat.S_IMODE(st.st_mode))} != {oct(mode)}: {path}")


def private_dir(path: pathlib.Path, mode: int) -> None:
    st = lstat(path)
    if not stat.S_ISDIR(st.st_mode):
        refuse(f"not a directory: {path}")
    if st.st_uid != os.geteuid():
        refuse(f"foreign owner: {path}")
    if stat.S_IMODE(st.st_mode) != mode:
        refuse(f"mode {oct(stat.S_IMODE(st.st_mode))} != {oct(mode)}: {path}")


def quoted_value(text: str, prefix: str) -> str | None:
    for line in text.splitlines():
        if prefix in line and '"' in line:
            return line.split('"', 2)[1]
    return None


def verify_profile(expect: dict) -> None:
    profile_dir = pathlib.Path(expect["profileDir"])
    text = regular_file(profile_dir / "tunnel.yaml", 0o600)
    private_dir(profile_dir, 0o700)
    if expect["tunnelId"] not in text:
        refuse("profile missing tunnel_id")
    credential = expect["credential"]
    if credential in text:
        refuse("synthetic credential appears in plaintext profile")
    key_ref = quoted_value(text, "api_key:")
    if key_ref is None or not key_ref.startswith("file:"):
        refuse("profile api_key is not a file: reference")
    key_file = pathlib.Path(key_ref[5:])
    if key_file.parent != profile_dir / ".credentials" or not key_file.is_file():
        refuse("credential file is not the profile-private generation")
    if regular_file(key_file, 0o600) != credential:
        refuse("credential file content does not match the synthetic fixture key")
    private_dir(profile_dir / ".credentials", 0o700)
    command = quoted_value(text, "command:")
    tokens = command.replace("'", "").split() if command else []
    if len(tokens) not in (4, 6) or tokens[0] != expect["nodePath"] or tokens[1] != expect["mcpScript"]:
        refuse("profile MCP command does not wire the installed runtime entrypoints")
    if tokens[2] != "--config" or not pathlib.Path(tokens[3]).is_file():
        refuse("profile MCP binding reference is missing on disk")


def verify_policy(expect: dict) -> None:
    bindings = pathlib.Path(expect["profileDir"]) / ".ce-bindings"
    private_dir(bindings, 0o700)
    documents = sorted(bindings.glob("messaging-*.yaml.pi-allowlist.json"))
    if not documents:
        refuse("no durable messaging/multi-session allowlist generation")
    registrations = []
    for document in documents:
        regular_file(document, 0o600)
        regular_file(document.with_name(document.name[:-len(".pi-allowlist.json")]), 0o600)
        parsed = json.loads(regular_file(document, 0o600))
        registrations.extend(parsed.get("registrations", []))
    match = [row for row in registrations if row.get("endpointId") == expect["endpoint"]]
    if not match:
        refuse(f"endpoint {expect['endpoint']} has no durable registration")
    row = match[0]
    if row.get("runtimeSessionId") != expect["sessionId"]:
        refuse("registration is bound to a different runtime session")
    epoch = row.get("epoch")
    if row.get("status") != "active" or not isinstance(epoch, int) or epoch < 1:
        refuse("registration is not an active durable epoch")


def verify_mutex(expect: dict) -> None:
    mutex = pathlib.Path(expect["profileDir"]) / ".ce-bindings" / ".ce-session-process-mutex"
    if not mutex.is_dir():
        refuse("session process mutex root missing")
    slots = [slot for scope in mutex.iterdir() if scope.is_dir()
             for slot in scope.iterdir() if slot.is_dir()]
    if not slots:
        refuse("no mutex slot recorded")
    for slot in slots:
        owner = json.loads(regular_file(slot / "owner.json", 0o600))
        released = json.loads(regular_file(slot / "released.json", 0o600))
        for field in ("scope", "pid", "birth", "processToken", "handleToken"):
            if owner.get(field) != released.get(field):
                refuse(f"owner/released mismatch on {field}")
        if owner.get("version") != 1 or not isinstance(owner.get("pid"), int):
            refuse("owner record shape invalid")


def verify_store(expect: dict) -> None:
    store = pathlib.Path(expect["profileDir"]) / ".ce-bindings" / expect.get("storeFile", "ce-store.sqlite")
    regular_mode(store, 0o600)
    probe = (
        "const{DatabaseSync}=require('node:sqlite');"
        "const fs=require('node:fs'),os=require('node:os'),path=require('node:path');"
        "const d=fs.mkdtempSync(path.join(os.tmpdir(),'ce-store-copy-'));"
        "const src=process.argv[1];"
        "for(const s of ['','-wal','-shm']){try{fs.copyFileSync(src+s,path.join(d,'copy.sqlite'+s))}catch{}}"
        "const db=new DatabaseSync(path.join(d,'copy.sqlite'),{readOnly:true});"
        "const rows=db.prepare('SELECT name FROM sqlite_master WHERE type=?').all('table');"
        "process.stdout.write(JSON.stringify(rows.map(r=>r.name)));db.close();"
    )
    result = subprocess.run([expect["nodePath"], "-e", probe, str(store)],
                            capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        refuse("synthetic store cannot be opened read-only: " + result.stderr[:200])
    tables = set(json.loads(result.stdout))
    missing = REQUIRED_STORE_TABLES - tables
    if missing:
        refuse(f"synthetic store schema incomplete, missing {sorted(missing)}")


COMMANDS = {"profile": verify_profile, "policy": verify_policy, "mutex": verify_mutex, "store": verify_store}


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in COMMANDS:
        raise SystemExit("usage: durable_state.py <profile|policy|mutex|store> <expect.json>")
    COMMANDS[sys.argv[1]](json.loads(pathlib.Path(sys.argv[2]).read_text()))
