#!/usr/bin/env python3
"""Append one metadata notification to an operator-selected private local file."""
import json
import os
import re
import stat
import sys

MAX_INPUT = 16384
FIELDS = {
    "schemaVersion", "event", "eventId", "eventKey", "messageId", "exchangeId",
    "sender", "recipient", "createdAt", "payloadDigest", "payloadLength",
}


def text(value, maximum):
    return (isinstance(value, str) and 0 < len(value) <= maximum
            and not any(ord(char) < 32 or ord(char) == 127 for char in value))


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate field")
        result[key] = value
    return result


def main():
    if len(sys.argv) != 2 or not os.path.isabs(sys.argv[1]):
        raise ValueError("absolute output required")
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        raise ValueError("input too large")
    try:
        event = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object)
    except (ValueError, UnicodeError) as error:
        raise ValueError("invalid JSON metadata") from error
    if not isinstance(event, dict) or set(event) != FIELDS:
        raise ValueError("invalid fields")
    if type(event["schemaVersion"]) is not int or event["schemaVersion"] != 1:
        raise ValueError("invalid version")
    if event["event"] != "ce.message.committed.v1":
        raise ValueError("invalid event")
    for field in ("eventId", "eventKey", "messageId", "exchangeId", "createdAt"):
        if not text(event[field], 512):
            raise ValueError("invalid reference")
    for field in ("sender", "recipient"):
        endpoint = event[field]
        if (not isinstance(endpoint, dict) or set(endpoint) != {"adapter", "endpointId"}
                or not text(endpoint["adapter"], 64) or not text(endpoint["endpointId"], 256)):
            raise ValueError("invalid endpoint")
    if not isinstance(event["payloadDigest"], str) or not re.fullmatch(r"[0-9a-f]{64}", event["payloadDigest"]):
        raise ValueError("invalid digest")
    if type(event["payloadLength"]) is not int or not 0 <= event["payloadLength"] <= 9007199254740991:
        raise ValueError("invalid length")
    line = (json.dumps(event, ensure_ascii=True, separators=(",", ":")) + "\n").encode("ascii")
    # The parent directory must be private and operator controlled. Never derive
    # paths from metadata; refuse symlinks, special files and shared output files.
    fd = os.open(sys.argv[1], os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077 or info.st_nlink != 1):
            raise ValueError("unsafe output")
        with os.fdopen(fd, "ab", closefd=False) as output:
            output.write(line)
    finally:
        os.close(fd)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, UnicodeError, RecursionError):
        # Do not echo metadata, paths or interpreter tracebacks to a host stream.
        sys.stderr.write("notification rejected\n")
        sys.exit(1)
