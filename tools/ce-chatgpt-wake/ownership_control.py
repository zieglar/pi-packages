#!/usr/bin/env python3
"""Local control for a native-received ownership feedback or a future reply intent.

This entry never enables the Hook, changes CE authority, sends CE messages or
reads business payloads. The calling Pi session treats feedback as terminal and
sends no ordinary CE report. EXPLICIT_USER is a workflow convention, not a
cryptographic attestation: use registration only after the user's actual statement.
"""
import argparse
import json
import re
import sqlite3
import subprocess
import sys

import auto_wake
import ownership_loop
import receipt_target
import wake


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--message-id', required=True)
    command = parser.add_mutually_exclusive_group(required=True)
    command.add_argument('--prepare-key')
    command.add_argument('--register-owner', action='store_true')
    command.add_argument('--feedback', action='store_true')
    args = parser.parse_args(argv)
    try:
        config = auto_wake.load_config(args.config)
        runtime = auto_wake.resolve_runtime(config)
        store = ownership_loop.store_for(config, runtime)
        if args.prepare_key:
            result = ownership_loop.prepare(args.message_id, args.prepare_key, config, runtime)
        else:
            raw = sys.stdin.read(2049)
            if len(raw.encode('utf8')) > 2048:
                raise ValueError('CONTROL_INPUT_TOO_LARGE')
            body = json.loads(raw, object_pairs_hook=wake.unique_object)
            if args.feedback:
                result = ownership_loop.receive_feedback(args.message_id, body, config, runtime)
            else:
                if not isinstance(body, dict) or set(body) != {'projectLabel', 'taskOwner', 'confirmation'}:
                    raise ValueError('REGISTRATION_INPUT_INVALID')
                receipt_target.inbound_claim(config, runtime, args.message_id, require_read=True)
                result = store.register(args.message_id, body['projectLabel'], body['taskOwner'], confirmation=body['confirmation'])
        print(json.dumps(result, sort_keys=True))
        return 0
    except (ValueError, OSError, sqlite3.Error, subprocess.SubprocessError) as error:
        code = str(error)
        if not re.fullmatch(r'[A-Z][A-Z0-9_]{1,79}', code):
            code = 'OWNERSHIP_CONTROL_REJECTED'
        print(json.dumps({'status': code, 'suppressOrdinaryReply': True}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
