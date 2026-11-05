"""Behavior tests for the CE Hook notification mode of wake.py.

Only the OS notification boundary is replaced. The validator, journal, lock,
state machine and CLI are exercised for real against temporary private
directories. No osascript, agent-desktop or ChatGPT operation is ever run.
"""
import contextlib
import datetime
import importlib.util
import io
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location('wake', Path(__file__).with_name('wake.py'))
assert spec and spec.loader
wake = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wake)

MSG = 'msg_01M6NKPRJEM88WCEPMQ0NS1HSH'
EXCHANGE = 'ho_01M6NKPRJEM88WCEPMQ0NS1HSH'
EVENT = 'evt_01M6NKPRJEM88WCEPMQ0NS1HSH'


def now():
    return datetime.datetime.now(datetime.UTC)


def event(**overrides):
    base = {
        'schemaVersion': 1,
        'event': 'ce.message.committed.v1',
        'eventId': EVENT,
        'eventKey': EXCHANGE + '/1',
        'messageId': MSG,
        'exchangeId': EXCHANGE,
        'sender': {'adapter': 'pi', 'endpointId': 'pi/session-test'},
        'recipient': {'adapter': 'chatgpt', 'endpointId': 'chatgpt/main'},
        'createdAt': now().isoformat(),
        'payloadDigest': 'a' * 64,
        'payloadLength': 12,
    }
    base.update(overrides)
    return base


def encode(value):
    return json.dumps(value).encode('utf-8')


class Notifier:
    """Fake OS notification boundary."""

    def __init__(self, error=None):
        self.calls = []
        self.error = error

    def __call__(self, text):
        self.calls.append(text)
        if self.error is not None:
            raise self.error
        return None


class HookTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name)
        self.config = {
            'hookSenderAdapter': 'pi',
            'hookSenderEndpointId': 'pi/session-test',
            'hookRecipientAdapter': 'chatgpt',
            'hookRecipientEndpointId': 'chatgpt/main',
            'hookExchangeId': EXCHANGE,
            'stateDir': self.tmp.name,
        }
        self.journal = self.state / ('hook-' + MSG + '.json')
        self.event = event()

    def notify(self, raw=None, config=None, notifier=None):
        return wake.notify_hook(encode(self.event) if raw is None else raw,
                                self.config if config is None else config,
                                notifier=notifier or Notifier())

    def test_matching_event_notifies_once_and_journals_attempt(self):
        notifier = Notifier()
        result = self.notify(notifier=notifier)
        self.assertEqual(result['notificationRequest'], 'REQUESTED')
        self.assertEqual(result['messageId'], MSG)
        self.assertEqual(len(notifier.calls), 1)
        self.assertIn(MSG, notifier.calls[0])
        self.assertTrue(self.journal.exists())
        info = self.journal.stat()
        self.assertEqual(stat.S_IMODE(info.st_mode), 0o600)
        self.assertEqual(info.st_uid, os.getuid())
        saved = json.loads(self.journal.read_text())
        self.assertEqual(saved['stage'], 'NOTIFICATION_REQUESTED')

    def test_notice_carries_identifiers_only(self):
        notifier = Notifier()
        self.notify(notifier=notifier)
        text = notifier.calls[0]
        self.assertIn(MSG, text)
        self.assertIn(EXCHANGE, text)
        self.assertNotIn('a' * 64, text)
        self.assertNotIn('payloadLength', text)

    def test_repeat_event_never_notifies_again(self):
        notifier = Notifier()
        first = self.notify(notifier=notifier)
        second = self.notify(notifier=notifier)
        self.assertEqual(first, second)
        self.assertEqual(len(notifier.calls), 1)

    def test_changed_metadata_for_same_message_refuses(self):
        self.notify(notifier=Notifier())
        changed = event(eventId='evt_' + '7' * 26)
        with self.assertRaisesRegex(ValueError, 'HOOK_MESSAGE_CONFLICT'):
            wake.notify_hook(encode(changed), self.config, notifier=Notifier())

    def test_historical_legacy_journal_blocks_notification(self):
        (self.state / (MSG + '.json')).write_text(json.dumps({'stage': 'NOTICE_OBSERVED'}))
        notifier = Notifier()
        with self.assertRaisesRegex(ValueError, 'HOOK_HISTORICAL_ATTEMPT'):
            self.notify(notifier=notifier)
        self.assertEqual(notifier.calls, [])

    def test_reverse_direction_is_refused(self):
        notifier = Notifier()
        reversed_event = event(sender={'adapter': 'chatgpt', 'endpointId': 'chatgpt/main'},
                               recipient={'adapter': 'pi', 'endpointId': 'pi/session-test'})
        with self.assertRaisesRegex(ValueError, 'HOOK_DIRECTION_DENIED'):
            wake.notify_hook(encode(reversed_event), self.config, notifier=notifier)
        self.assertEqual(notifier.calls, [])

    def test_wrong_sender_recipient_or_exchange_is_refused(self):
        cases = [
            ({'sender': {'adapter': 'pi', 'endpointId': 'pi/other'}}, 'HOOK_SENDER_DENIED'),
            ({'recipient': {'adapter': 'chatgpt', 'endpointId': 'chatgpt/other'}}, 'HOOK_RECIPIENT_DENIED'),
            ({'exchangeId': 'ho_' + '7' * 26}, 'HOOK_EXCHANGE_DENIED'),
        ]
        for overrides, code in cases:
            with self.subTest(code=code):
                notifier = Notifier()
                with self.assertRaisesRegex(ValueError, code):
                    wake.notify_hook(encode(event(**overrides)), self.config, notifier=notifier)
                self.assertEqual(notifier.calls, [])

    def test_missing_extra_and_duplicate_fields_are_refused(self):
        missing = event()
        del missing['exchangeId']
        with self.assertRaisesRegex(ValueError, 'HOOK_EVENT_FIELDS_INVALID'):
            wake.notify_hook(encode(missing), self.config, notifier=Notifier())
        with self.assertRaisesRegex(ValueError, 'HOOK_EVENT_FIELDS_INVALID'):
            wake.notify_hook(encode(event(payload='secret')), self.config, notifier=Notifier())
        duplicate = '{"schemaVersion":1,"schemaVersion":1}'
        with self.assertRaisesRegex(ValueError, 'HOOK_INPUT_DUPLICATE_FIELD'):
            wake.notify_hook(duplicate.encode('utf-8'), self.config, notifier=Notifier())

    def test_invalid_identifiers_digest_length_and_time_are_refused(self):
        cases = [
            ({'eventId': 'evt_x'}, 'HOOK_EVENT_ID_INVALID'),
            ({'messageId': 'msg_x'}, 'HOOK_MESSAGE_ID_INVALID'),
            ({'exchangeId': 'ho_x'}, 'HOOK_EXCHANGE_ID_INVALID'),
            ({'eventKey': 'not-a-key'}, 'HOOK_EVENT_KEY_INVALID'),
            ({'payloadDigest': 'A' * 64}, 'HOOK_PAYLOAD_DIGEST_INVALID'),
            ({'payloadLength': -1}, 'HOOK_PAYLOAD_LENGTH_INVALID'),
            ({'payloadLength': True}, 'HOOK_PAYLOAD_LENGTH_INVALID'),
            ({'createdAt': 'not-a-time'}, 'HOOK_CREATED_AT_INVALID'),
            ({'createdAt': '2026-11-05T07:57:49.169066'}, 'HOOK_CREATED_AT_INVALID'),
            ({'schemaVersion': True}, 'HOOK_SCHEMA_VERSION_INVALID'),
            ({'schemaVersion': 2}, 'HOOK_SCHEMA_VERSION_INVALID'),
            ({'event': 'ce.other.v1'}, 'HOOK_EVENT_NAME_INVALID'),
        ]
        for overrides, code in cases:
            with self.subTest(code=code):
                notifier = Notifier()
                with self.assertRaisesRegex(ValueError, code):
                    wake.notify_hook(encode(event(**overrides)), self.config, notifier=notifier)
                self.assertEqual(notifier.calls, [])

    def test_endpoint_shape_is_closed(self):
        notifier = Notifier()
        bad = event(sender={'adapter': 'pi', 'endpointId': 'pi/session-test', 'secret': 'x'})
        with self.assertRaisesRegex(ValueError, 'HOOK_ENDPOINT_INVALID'):
            wake.notify_hook(encode(bad), self.config, notifier=notifier)
        missing = event()
        del missing['sender']['endpointId']
        with self.assertRaisesRegex(ValueError, 'HOOK_ENDPOINT_INVALID'):
            wake.notify_hook(encode(missing), self.config, notifier=notifier)
        self.assertEqual(notifier.calls, [])

    def test_oversized_and_invalid_encoding_input_are_refused(self):
        notifier = Notifier()
        oversized = b'{"padding":"' + b'x' * 16384 + b'"}'
        with self.assertRaisesRegex(ValueError, 'HOOK_INPUT_TOO_LARGE'):
            wake.notify_hook(oversized, self.config, notifier=notifier)
        with self.assertRaisesRegex(ValueError, 'HOOK_INPUT_INVALID_ENCODING'):
            wake.notify_hook(b'{"schemaVersion":1,\xff}', self.config, notifier=notifier)
        with self.assertRaisesRegex(ValueError, 'HOOK_INPUT_INVALID_JSON'):
            wake.notify_hook(b'{', self.config, notifier=notifier)
        with self.assertRaisesRegex(ValueError, 'HOOK_EVENT_FIELDS_INVALID'):
            wake.notify_hook(b'[]', self.config, notifier=notifier)
        self.assertEqual(notifier.calls, [])

    def test_local_config_is_closed_and_strict(self):
        notifier = Notifier()
        for mutate in (lambda c: c.pop('hookExchangeId'),
                       lambda c: c.update(extra='x'),
                       lambda c: c.update(stateDir='relative/dir'),
                       lambda c: c.update(hookSenderAdapter='chatgpt')):
            with self.subTest():
                config = dict(self.config)
                mutate(config)
                with self.assertRaisesRegex(ValueError, 'HOOK_CONFIG_INVALID'):
                    wake.notify_hook(encode(event()), config, notifier=notifier)
        self.assertEqual(notifier.calls, [])

    def test_stale_and_future_events_are_refused(self):
        notifier = Notifier()
        stale = event(createdAt=(now() - datetime.timedelta(seconds=600)).isoformat())
        with self.assertRaisesRegex(ValueError, 'HOOK_EVENT_STALE'):
            wake.notify_hook(encode(stale), self.config, notifier=notifier)
        future = event(createdAt=(now() + datetime.timedelta(seconds=60)).isoformat())
        with self.assertRaisesRegex(ValueError, 'HOOK_EVENT_FROM_FUTURE'):
            wake.notify_hook(encode(future), self.config, notifier=notifier)
        self.assertEqual(notifier.calls, [])
        boundary = event(createdAt=(now() - datetime.timedelta(seconds=119)).isoformat())
        self.assertEqual(self.notify(raw=encode(boundary), notifier=notifier)['notificationRequest'], 'REQUESTED')

    def test_uncertain_notifier_failure_is_persisted_and_never_retried(self):
        failing = Notifier(error=OSError('unavailable'))
        result = self.notify(notifier=failing)
        self.assertEqual(result['notificationRequest'], 'UNKNOWN')
        saved = json.loads(self.journal.read_text())
        self.assertEqual(saved['stage'], 'NOTIFICATION_UNKNOWN')
        again = Notifier()
        second = self.notify(notifier=again)
        self.assertEqual(second, result)
        self.assertEqual(again.calls, [])

    def test_attempt_is_persisted_before_the_notifier_call(self):
        observed = []

        def notifier(text):
            observed.append(json.loads(self.journal.read_text())['stage'])
            return None

        self.notify(notifier=notifier)
        self.assertEqual(observed, ['NOTIFICATION_ATTEMPTED'])

    def test_private_state_directory_is_required(self):
        notifier = Notifier()
        public = Path(self.tmp.name) / 'public'
        # Deliberately unsafe fixture: verify shared state is refused.
        previous = os.umask(0)
        try:
            public.mkdir(mode=0o755)
        finally:
            os.umask(previous)
        config = dict(self.config, stateDir=str(public))
        with self.assertRaisesRegex(ValueError, 'PRIVATE_STATE_REQUIRED'):
            wake.notify_hook(encode(event()), config, notifier=notifier)
        link = Path(self.tmp.name) / 'link'
        os.symlink(str(self.state), str(link))
        config = dict(self.config, stateDir=str(link))
        with self.assertRaisesRegex(ValueError, 'PRIVATE_STATE_REQUIRED'):
            wake.notify_hook(encode(event()), config, notifier=notifier)
        self.assertEqual(notifier.calls, [])

    def test_unsafe_or_busy_lock_never_notifies(self):
        lock = self.state / '.lock'
        target = self.state / 'target'
        target.write_text('untouched')
        lock.symlink_to(target)
        with self.assertRaises(OSError):
            self.notify()
        self.assertEqual(target.read_text(), 'untouched')
        lock.unlink()
        lock.hardlink_to(target)
        with self.assertRaisesRegex(ValueError, 'HOOK_STATE_FILE_UNSAFE'):
            self.notify()
        lock.unlink()
        with lock.open('w') as held:
            os.fchmod(held.fileno(), 0o600)
            wake.fcntl.flock(held, wake.fcntl.LOCK_EX | wake.fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.notify()
        self.assertFalse(self.journal.exists())

    def test_existing_journal_symlink_fifo_or_corruption_never_notifies(self):
        notifier = Notifier()
        target = self.state / 'target'
        target.write_text('untouched')
        self.journal.symlink_to(target)
        with self.assertRaises(OSError):
            self.notify(notifier=notifier)
        self.journal.unlink()
        os.mkfifo(self.journal, mode=0o600)
        with self.assertRaisesRegex(ValueError, 'HOOK_STATE_FILE_UNSAFE'):
            self.notify(notifier=notifier)
        self.journal.unlink()
        self.journal.write_text('corrupt')
        os.chmod(self.journal, 0o600)
        with self.assertRaises(ValueError):
            self.notify(notifier=notifier)
        self.assertEqual(notifier.calls, [])
        self.assertEqual(target.read_text(), 'untouched')

    def test_interrupted_attempt_is_never_retried(self):
        with self.assertRaises(KeyboardInterrupt):
            self.notify(notifier=Notifier(error=KeyboardInterrupt()))
        self.assertEqual(json.loads(self.journal.read_text())['stage'], 'NOTIFICATION_ATTEMPTED')
        notifier = Notifier()
        self.assertEqual(self.notify(notifier=notifier)['notificationRequest'], 'UNKNOWN')
        self.assertEqual(notifier.calls, [])

    def test_invalid_event_creates_no_attempt_files(self):
        with self.assertRaises(ValueError):
            self.notify(raw=encode(event(payload='forbidden')))
        self.assertEqual(list(self.state.iterdir()), [])

    def test_native_backend_passes_the_notice_as_data(self):
        with mock.patch.object(wake.subprocess, 'run') as runner:
            wake.osascript_notifier('text with "quotes" and $HOME')
        args, kwargs = runner.call_args
        command = args[0]
        self.assertEqual(command[0], '/usr/bin/osascript')
        self.assertEqual(command[-1], 'text with "quotes" and $HOME')
        self.assertNotIn('quotes', command[1])
        self.assertNotIn('HOME', command[1])
        self.assertFalse(kwargs.get('shell', False))
        self.assertEqual(kwargs['timeout'], 5)

    def test_hook_cli_never_touches_the_legacy_desktop_driver(self):
        config_path = self.state / 'hook.json'
        config_path.write_text(json.dumps(self.config))
        forbidden = mock.Mock(side_effect=AssertionError('legacy driver used'))
        with mock.patch.object(wake, 'ChatGptCli', forbidden), \
                mock.patch.object(wake, 'run', forbidden), \
                mock.patch.object(wake, 'osascript_notifier', Notifier()), \
                mock.patch.object(wake.sys, 'stdin', io.TextIOWrapper(io.BytesIO(encode(event())))):
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                code = wake.main(['--config', str(config_path), '--hook'])
        self.assertEqual(code, 0)
        forbidden.assert_not_called()
        self.assertEqual(json.loads(buffer.getvalue())['notificationRequest'], 'REQUESTED')

    def test_hook_cli_reports_rejection_without_traceback(self):
        config_path = self.state / 'hook.json'
        config_path.write_text(json.dumps(self.config))
        errors = io.StringIO()
        with mock.patch.object(wake.sys, 'stdin', io.TextIOWrapper(io.BytesIO(b'{'))), \
                contextlib.redirect_stderr(errors):
            code = wake.main(['--config', str(config_path), '--hook'])
        self.assertEqual(code, 1)
        self.assertNotIn('Traceback', errors.getvalue())
        self.assertIn('HOOK_INPUT_INVALID_JSON', errors.getvalue())

    def test_hook_cli_requires_exactly_one_mode(self):
        config_path = self.state / 'hook.json'
        config_path.write_text(json.dumps(self.config))
        with mock.patch.object(wake.sys, 'stderr', io.StringIO()):
            with self.assertRaises(SystemExit):
                wake.main(['--config', str(config_path)])
            with self.assertRaises(SystemExit):
                wake.main(['--config', str(config_path), '--hook', '--record', 'x.json'])


if __name__ == '__main__':
    unittest.main()
