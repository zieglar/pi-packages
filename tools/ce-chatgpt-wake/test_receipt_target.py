"""Receipt policy tests use real private journals/SQLite, with only desktop/runtime seams fake."""
import contextlib
import io
import json
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

import test_auto_wake
import test_wake

import receipt_target as receipt


class ReceiptTargetTests(unittest.TestCase):
    def test_caller_cannot_choose_or_observe_reply_key_before_confirmation(self):
        self.capture()
        config = {**self.config, 'ownerDirectory': str(self.root)}
        entry = self.root / 'config.json'
        receipt.wake.write_state(entry, {'autoWakeConfig': str(self.root / 'auto-wake.json')})
        output = io.StringIO()
        real_write = receipt.wake.write_state
        outgoing = dict(self.event, messageId='msg_' + '8' * 26, eventKey=self.event['exchangeId'] + '/2')
        def race(path, value):
            if path.name.endswith('.ready.json'):
                self.assertEqual(output.getvalue(), '')
                self.assertNotIn('--idempotency-key', sys.argv)
                self.db.execute('INSERT INTO message VALUES(?,?,?,?,?,?,?,?)',
                                (outgoing['messageId'], outgoing['exchangeId'], json.dumps(outgoing['sender']),
                                 json.dumps(outgoing['recipient']), outgoing['payloadDigest'], outgoing['payloadLength'],
                                 outgoing['createdAt'], 'caller-chosen-key'))
                self.db.execute('INSERT INTO audit_event VALUES(?,?,?,?,?,?)',
                                (2, 'message_created', outgoing['messageId'], outgoing['createdAt'], None, outgoing['exchangeId']))
                self.db.commit()
            real_write(path, value)
        argv = ['receipt_target.py', '--config', str(entry), '--session-id', 'native-runtime',
                '--endpoint-id', 'pi/session-test', '--prepare-reply', self.event['messageId'], '--task-id', 'task-label']
        with (mock.patch.object(sys, 'argv', argv), contextlib.redirect_stdout(output),
              mock.patch.object(receipt.auto_wake, 'load_config', return_value=config),
              mock.patch.object(receipt.auto_wake, 'resolve_runtime', return_value=self.runtime),
              mock.patch.object(receipt.wake, 'write_state', side_effect=race)):
            self.assertEqual(receipt.main(), 0)
        prepared = json.loads(output.getvalue())
        self.assertRegex(prepared['idempotencyKey'], r'^ce-desktop-[0-9a-f]{64}$')
        self.assertIsNone(receipt.lookup_reply(outgoing, config, self.runtime))

    def test_reply_committed_during_binding_confirmation_is_suppressed(self):
        self.capture()
        outgoing = dict(self.event, messageId='msg_' + '5' * 26, eventKey=self.event['exchangeId'] + '/2')
        connect = receipt.sqlite3.connect
        inserted = []
        class Database:
            def __init__(driver, connection):
                driver.connection = connection
            def __getattr__(driver, name):
                return getattr(driver.connection, name)
            def execute(driver, sql, args=()):
                if sql.startswith('SELECT COALESCE(MAX(sequence)') and not inserted:
                    self.db.execute('INSERT INTO message VALUES(?,?,?,?,?,?,?,?)',
                                    (outgoing['messageId'], outgoing['exchangeId'], json.dumps(outgoing['sender']),
                                     json.dumps(outgoing['recipient']), outgoing['payloadDigest'], outgoing['payloadLength'],
                                     outgoing['createdAt'], 'racing-key'))
                    self.db.execute('INSERT INTO audit_event VALUES(?,?,?,?,?,?)',
                                    (2, 'message_created', outgoing['messageId'], outgoing['createdAt'], None, outgoing['exchangeId']))
                    self.db.commit()
                    inserted.append(True)
                return driver.connection.execute(sql, args)
        with mock.patch.object(receipt.auto_wake, 'resolve_runtime', return_value=self.runtime), \
                mock.patch.object(receipt.sqlite3, 'connect', side_effect=lambda *a, **kw: Database(connect(*a, **kw))):
            receipt.prepare(self.event['messageId'], 'task-label', 'racing-key', self.config,
                            'native-runtime', 'pi/session-test')
        self.assertEqual(inserted, [True])
        with self.assertRaisesRegex(ValueError, 'REPLY_ASSOCIATION_NOT_PRIOR'):
            receipt.lookup_reply(outgoing, self.config, self.runtime)

    def test_reply_without_post_binding_audit_confirmation_stays_suppressed(self):
        self.capture()
        with mock.patch.object(receipt.auto_wake, 'resolve_runtime', return_value=self.runtime):
            receipt.prepare(self.event['messageId'], 'task-label', 'not-confirmed', self.config,
                            'native-runtime', 'pi/session-test')
        binding = receipt.key_path(self.config, 'not-confirmed')
        binding.with_name(binding.stem + '.ready.json').unlink(missing_ok=True)
        outgoing = dict(self.event, messageId='msg_' + '6' * 26, eventKey=self.event['exchangeId'] + '/2')
        self.db.execute('INSERT INTO message VALUES(?,?,?,?,?,?,?,?)',
                        (outgoing['messageId'], outgoing['exchangeId'], json.dumps(outgoing['sender']),
                         json.dumps(outgoing['recipient']), outgoing['payloadDigest'], outgoing['payloadLength'],
                         outgoing['createdAt'], 'not-confirmed'))
        self.db.commit()
        self.assertIsNone(receipt.lookup_reply(outgoing, self.config, self.runtime))

    def test_closed_entry_or_explicit_mode_blocks_existing_notification_authority(self):
        cfg = dict(self.config, ownerDirectory=str(self.root))
        record = {'messageId': self.event['messageId']}
        entry = self.root / 'config.json'
        receipt.wake.write_state(entry, {})
        with mock.patch.object(receipt.auto_wake, 'resolve_runtime') as runtime, \
                self.assertRaisesRegex(ValueError, 'WAKE_ENTRY_CLOSED'):
            receipt.current_binding(record, cfg)
        runtime.assert_not_called()
        receipt.wake.write_state(entry, {'autoWakeConfig': str(self.root / 'auto-wake.json')})
        cfg['conversationGuard']['mode'] = 'explicit-only'
        with mock.patch.object(receipt.auto_wake, 'load_config', return_value=cfg), \
                mock.patch.object(receipt.auto_wake, 'resolve_runtime') as runtime, \
                self.assertRaisesRegex(ValueError, 'GUARD_NOT_AUTOMATIC'):
            receipt.current_binding(record, cfg)
        runtime.assert_not_called()

    def test_late_prepare_and_changed_owner_cannot_rebind_original_request(self):
        self.capture()
        self.db.execute("UPDATE message SET idempotency_key='already-committed'")
        self.db.commit()
        with mock.patch.object(receipt.auto_wake, 'resolve_runtime', return_value=self.runtime), \
                self.assertRaisesRegex(ValueError, 'REPLY_ALREADY_COMMITTED'):
            receipt.prepare(self.event['messageId'], 'task', 'already-committed', self.config,
                            'native-runtime', 'pi/session-test')
        changed = dict(self.runtime, ceSessionId='new-owner')
        with mock.patch.object(receipt.auto_wake, 'resolve_runtime', return_value=changed), \
                self.assertRaisesRegex(ValueError, 'TARGET_BINDING_UNAVAILABLE'):
            receipt.prepare(self.event['messageId'], 'task', 'unused-key', self.config,
                            'native-runtime', 'pi/session-test')

    def test_interrupted_capture_never_observes_a_replacement_title(self):
        folder = receipt.directory(self.config)
        path = receipt.request_path(self.config, self.event['messageId'])
        receipt.wake.write_state(path, {'status': 'UNAVAILABLE', 'reason': 'CAPTURE_MAY_HAVE_OCCURRED'})
        with mock.patch.object(receipt.wake, 'ChatGptCli') as desktop, \
                mock.patch.object(receipt.auto_wake, 'resolve_runtime', return_value=self.runtime):
            outcome = receipt.capture(self.event['messageId'], self.config, 'native-runtime', 'pi/session-test')
        self.assertEqual(outcome['status'], 'UNAVAILABLE')
        desktop.assert_not_called()
        self.assertEqual(path.parent, folder)

    def test_button_rechecks_title_and_refuses_change_between_fill_and_submit(self):
        self.capture()
        target = receipt.auto_wake.read_private(receipt.request_path(self.config, self.event['messageId']))['target']
        auto = receipt.auto_wake
        for case in ('still-other', 'returned', 'changed-after-fill'):
            with self.subTest(case=case):
                title = ['Other B']
                instances = []
                class Desktop(test_wake.Desktop):
                    def __init__(driver, cfg):
                        super().__init__()
                        driver.fills = 0
                        instances.append(driver)
                    def call(driver, _):
                        return {'data': [{'id': 'w-1', 'title': 'ChatGPT', 'pid': 5, 'process_instance': 'generation'}]}
                    def snapshot(driver):
                        return test_wake.snapshot(driver.draft, [driver.notice] if driver.notice else [], title[0])
                    def fill(driver, ref, text):
                        driver.fills += 1
                        super().fill(ref, text)
                        if case == 'changed-after-fill':
                            title[0] = 'Other B'
                cfg = dict(self.config, stateDir=str(self.root / case), terminalNotifier=receipt.sys.executable,
                           notificationTimeoutSeconds=1, _receiptTarget=target)
                auto.private_dir(cfg['stateDir'])
                record = {'testId': 'CE-WAKE-AUTO-' + self.event['messageId'][4:],
                          'messageId': self.event['messageId'], 'to': 'chatgpt/main',
                          'replyTo': 'pi/session-test', 'disposition': 'CREATED'}
                def notifier(request, _):
                    self.assertEqual(request['action'], '回到目标会话后继续')
                    self.assertIn('Target A', request['message'])
                    if case != 'still-other':
                        title[0] = 'Target A'
                    return request['action']
                with mock.patch.object(auto.notification, 'terminal_notifier', side_effect=notifier), \
                        mock.patch.object(auto.notification, 'remove_notification') as remove, \
                        mock.patch.object(auto, 'validate_current'), \
                        mock.patch.object(receipt, 'current_binding', return_value=(cfg, self.runtime, target)), \
                        mock.patch.object(auto.wake, 'ChatGptCli', Desktop):
                    result = auto.interactive_fallback(record, cfg, self.runtime)
                self.assertEqual(instances[0].fills, 0 if case == 'still-other' else 1)
                self.assertEqual(instances[0].sends, 1 if case == 'returned' else 0)
                self.assertEqual(result['state'], 'TAKEN_OVER' if case == 'returned' else 'UNKNOWN')
                self.assertEqual(remove.call_count, 1 if case == 'returned' else 0)

    def test_committed_reply_uses_prepared_exact_request_and_title_target(self):
        self.capture()
        with mock.patch.object(receipt.auto_wake, 'resolve_runtime', return_value=self.runtime):
            receipt.prepare(self.event['messageId'], 'task-label', 'prepared-key', self.config,
                            'native-runtime', 'pi/session-test')
        outgoing = dict(self.event, messageId='msg_' + '7' * 26, eventKey=self.event['exchangeId'] + '/2')
        self.db.execute('INSERT INTO message VALUES(?,?,?,?,?,?,?,?)',
                        (outgoing['messageId'], outgoing['exchangeId'], json.dumps(outgoing['sender']),
                         json.dumps(outgoing['recipient']), outgoing['payloadDigest'], outgoing['payloadLength'],
                         outgoing['createdAt'], 'prepared-key'))
        self.db.execute('INSERT INTO audit_event VALUES(?,?,?,?,?,?)',
                        (2, 'message_created', outgoing['messageId'], outgoing['createdAt'], None, outgoing['exchangeId']))
        self.db.commit()
        receipt.auto_wake.enqueue(json.dumps(outgoing).encode(), self.config,
                                  resolve=lambda _: self.runtime, spawn=lambda *_: None)
        attempt = mock.Mock(return_value={'stage': 'NOTICE_OBSERVED', 'result': {'noticeSubmission': 'OBSERVED'}})
        fallback = mock.Mock()
        result = receipt.auto_wake.work(outgoing['messageId'], self.config, resolve=lambda _: self.runtime,
                                        attempt=attempt, fallback=fallback)
        self.assertEqual(result['stage'], 'OBSERVED')
        self.assertEqual(attempt.call_args.args[1]['_receiptTarget']['title'], 'Target A')
        self.assertEqual(attempt.call_args.args[1]['_receiptTarget']['requestMessageId'], self.event['messageId'])
        fallback.assert_not_called()

    def test_receipt_policy_is_explicit_and_closed(self):
        guard = receipt.auto_wake.conversation_guard
        configured = {'mode': 'explicit-only', 'targetSelection': 'desktop-at-intake', 'captureAfterAuditSequence': 158}
        self.assertEqual(guard.validate_config(configured), configured)
        self.assertIsNone(guard.automatic_decision('title-match', target={'selection': 'DESKTOP_AT_INTAKE_NOT_ACTUAL_ORIGIN'}))
        self.assertIsNotNone(guard.automatic_decision('explicit-only', target={'selection': 'DESKTOP_AT_INTAKE_NOT_ACTUAL_ORIGIN'}))

    def setUp(self):
        fixture = test_auto_wake.AutoWakeTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.root, self.db, self.event = fixture.root, fixture.db, fixture.event
        self.config, self.runtime = fixture.config, fixture.runtime
        self.config.update(conversationGuard={'mode': 'title-match', 'targetSelection': 'desktop-at-intake',
                                             'captureAfterAuditSequence': 0},
                           conversationMarker='HANDOFF-CE-CHATGPT-WAKE-01', agentDesktop='/unused/desktop',
                           maxWaitSeconds=1, nativeSessionFile=str(self.root / 'native.jsonl'))
        self.runtime.update(runtimeSessionId='native-runtime', policyDigest='b' * 64)
        self.db.execute('ALTER TABLE message ADD COLUMN idempotency_key')
        self.db.execute('ALTER TABLE audit_event ADD COLUMN exchange_id')
        self.db.execute('UPDATE audit_event SET exchange_id=?', (self.event['exchangeId'],))
        self.db.execute('UPDATE message SET from_endpoint_json=?,to_endpoint_json=?',
                        (json.dumps(self.event['recipient']), json.dumps(self.event['sender'])))
        self.db.commit()
        self.claim = {'runtimeSessionId': 'native-runtime', 'endpointId': 'pi/session-test',
                      'messageId': self.event['messageId'], 'auditSequence': 1, 'admittedAt': int(time.time() * 1000),
                      'metadata': {'messageId': self.event['messageId'], 'auditSequence': 1,
                                   'exchangeId': self.event['exchangeId'], 'from': 'chatgpt/main', 'to': 'pi/session-test',
                                   'payloadDigest': self.event['payloadDigest'], 'payloadLength': self.event['payloadLength'],
                                   'createdAt': self.event['createdAt']}}
        self.write_history()

    def write_history(self, received=True):
        entries = [{'type': 'session', 'id': 'native-runtime'},
                   {'type': 'custom', 'customType': 'ce-inbound-wake', 'data': self.claim}]
        if received:
            entries.append({'type': 'custom', 'customType': 'ce-inbound-receive',
                            'data': {'messageId': self.event['messageId'], 'status': 'RETURNED'}})
        path = Path(self.config['nativeSessionFile'])
        path.write_text(''.join(json.dumps(x) + '\n' for x in entries))
        path.chmod(0o600)

    def capture(self, title='Target A', envelope=None):
        class Desktop:
            def __init__(self, _):
                pass
            def call(self, _):
                return {'data': [{'id': 'w-1', 'title': 'ChatGPT', 'pid': 5, 'process_instance': 'generation'}]}
            def snapshot(self):
                return envelope if envelope is not None else test_wake.snapshot(title=title)
        with mock.patch.object(receipt.auto_wake, 'resolve_runtime', return_value=self.runtime), \
                mock.patch.object(receipt.wake, 'ChatGptCli', Desktop), \
                mock.patch.object(receipt.tempfile, 'mkdtemp', return_value=str(self.root / 'tmp')):
            return receipt.capture(self.event['messageId'], self.config, 'native-runtime', 'pi/session-test')

    def test_marker_missing_still_captures_observation_but_never_authorizes_desktop(self):
        envelope = test_wake.snapshot(title='Target A')
        envelope['data']['tree']['children'][0]['children'][0]['name'] = 'ordinary text'
        result = self.capture(envelope=envelope)
        self.assertEqual(result['status'], 'CAPTURED')
        saved = receipt.auto_wake.read_private(receipt.request_path(self.config, self.event['messageId']))
        self.assertEqual(saved['version'], 2)
        self.assertEqual(saved['markerObservation'], 'MISSING')
        self.assertEqual(saved['target']['title'], 'Target A')
        self.assertEqual(saved['selection'], 'DESKTOP_AT_INTAKE_NOT_ACTUAL_ORIGIN')
        with mock.patch.object(receipt.auto_wake, 'resolve_runtime', return_value=self.runtime):
            prepared = receipt.prepare(self.event['messageId'], 'observation-task', 'observation-key', self.config,
                                       'native-runtime', 'pi/session-test')
        self.assertEqual(prepared['status'], 'PREPARED')
        outgoing = dict(self.event, messageId='msg_' + '9' * 26, eventKey=self.event['exchangeId'] + '/2')
        self.db.execute('INSERT INTO message VALUES(?,?,?,?,?,?,?,?)',
                        (outgoing['messageId'], outgoing['exchangeId'], json.dumps(outgoing['sender']),
                         json.dumps(outgoing['recipient']), outgoing['payloadDigest'], outgoing['payloadLength'],
                         outgoing['createdAt'], prepared['idempotencyKey']))
        self.db.execute('INSERT INTO audit_event VALUES(?,?,?,?,?,?)',
                        (2, 'message_created', outgoing['messageId'], outgoing['createdAt'], None, outgoing['exchangeId']))
        self.db.commit()
        binding = receipt.auto_wake.read_private(receipt.key_path(self.config, prepared['idempotencyKey']))
        self.assertEqual((binding['requestMessageId'], binding['taskId'], binding['exchangeId']),
                         (self.event['messageId'], 'observation-task', outgoing['exchangeId']))
        binding_path = receipt.key_path(self.config, prepared['idempotencyKey'])
        ready = receipt.confirmation(binding_path.with_name(binding_path.stem + '.ready.json'), binding)
        actual_audit = self.db.execute('SELECT kind, subject_id FROM audit_event WHERE sequence=?', (2,)).fetchone()
        self.assertEqual(actual_audit, ('message_created', outgoing['messageId']))
        self.assertLess(ready['observedThroughSequence'], 2)
        self.assertIsNone(receipt.lookup_reply(outgoing, self.config, self.runtime))
        saved['version'] = 1
        saved.pop('markerObservation')
        receipt.wake.write_state(receipt.request_path(self.config, self.event['messageId']), saved)
        self.assertIsNone(receipt.lookup_reply(outgoing, self.config, self.runtime))
        saved.update(version=2, markerObservation='UNKNOWN')
        receipt.wake.write_state(receipt.request_path(self.config, self.event['messageId']), saved)
        with self.assertRaisesRegex(ValueError, 'TARGET_BINDING_UNAVAILABLE'):
            receipt.lookup_reply(outgoing, self.config, self.runtime)
        with self.assertRaisesRegex(ValueError, 'CONVERSATION_MARKER_MISSING'):
            receipt.wake.observe(envelope, {'windowId': 'w-1', 'conversationMarker': self.config['conversationMarker']})

    def test_observation_rejects_busy_draft_duplicate_input_or_incomplete_snapshot(self):
        kinds = ('busy', 'draft', 'draft-absent', 'draft-null', 'duplicate-input', 'duplicate-webarea', 'incomplete', 'empty-title')
        for index, kind in enumerate(kinds):
            with self.subTest(kind=kind):
                # Separate incoming IDs keep each immutable attempt independent.
                self.event['messageId'] = 'msg_' + str(index) * 26
                self.claim['messageId'] = self.event['messageId']
                self.claim['metadata']['messageId'] = self.event['messageId']
                self.db.execute('UPDATE message SET message_id=?', (self.event['messageId'],))
                self.db.execute('UPDATE audit_event SET subject_id=?', (self.event['messageId'],))
                self.db.commit(); self.write_history()
                envelope = test_wake.snapshot(title='Target A')
                children = envelope['data']['tree']['children'][0]['children']
                if kind == 'busy': children.append({'role': 'button', 'name': '停止生成'})
                elif kind == 'draft': children[1]['value'] = 'user draft'
                elif kind == 'draft-absent': children[1].pop('value')
                elif kind == 'draft-null': children[1]['value'] = None
                elif kind == 'duplicate-input': children.append(dict(children[1]))
                elif kind == 'duplicate-webarea': envelope['data']['tree']['children'].append({'role': 'webarea', 'name': 'other'})
                elif kind == 'incomplete': envelope['data']['complete'] = False
                else: envelope['data']['tree']['children'][0]['name'] = ''
                result = self.capture(envelope=envelope)
                self.assertEqual(result['status'], 'UNAVAILABLE')

    def test_capture_failure_has_specific_counts_without_recording_draft_content(self):
        cases = [('composer-missing', 0, 1), ('send-missing', 1, 0), ('duplicate-input', 2, 1),
                 ('duplicate-send', 1, 2), ('invalid-input-role', 0, 1), ('invalid-send-role', 1, 0)]
        for index, (kind, inputs, sends) in enumerate(cases):
            with self.subTest(kind=kind):
                self.event['messageId'] = 'msg_' + str(index + 2) * 26
                self.claim['messageId'] = self.event['messageId']
                self.claim['metadata']['messageId'] = self.event['messageId']
                self.db.execute('UPDATE message SET message_id=?', (self.event['messageId'],))
                self.db.execute('UPDATE audit_event SET subject_id=?', (self.event['messageId'],))
                self.db.commit(); self.write_history()
                envelope = test_wake.snapshot(title='pi-chat-exchange@3')
                children = envelope['data']['tree']['children'][0]['children']
                if kind == 'composer-missing': children.pop(1)
                elif kind == 'send-missing': children.pop(2)
                elif kind == 'duplicate-input': children.append(dict(children[1]))
                elif kind == 'duplicate-send': children.append(dict(children[2]))
                elif kind == 'invalid-input-role': children[1]['role'] = 'statictext'
                else: children[2]['role'] = 'group'
                self.assertEqual(self.capture(envelope=envelope)['status'], 'UNAVAILABLE')
                saved = receipt.auto_wake.read_private(receipt.request_path(self.config, self.event['messageId']))
                self.assertEqual(saved['reason'], 'INPUT_OR_SEND_AMBIGUOUS')
                self.assertEqual((saved['candidateCounts']['composer'], saved['candidateCounts']['send']), (inputs, sends))
                self.assertIn('draftState', saved)
                self.assertNotIn('draft', saved)
                self.assertNotIn('target', saved)
                self.assertEqual(saved['controls']['window'], {'id': 'w-1', 'title': 'pi-chat-exchange@3'})
                self.assertEqual(saved['controls']['selectedWindow'], {'id': 'w-1', 'title': 'ChatGPT', 'pid': 5, 'processInstance': 'generation'})

    def test_old_snapshot_format_stays_unavailable_despite_diagnostic_metadata(self):
        envelope = test_wake.snapshot()
        envelope['version'] = '2.4'
        self.assertEqual(self.capture(envelope=envelope)['reason'], 'SNAPSHOT_DENIED')
        saved = receipt.auto_wake.read_private(receipt.request_path(self.config, self.event['messageId']))
        self.assertEqual(saved['status'], 'UNAVAILABLE')
        self.assertNotIn('target', saved)


    def test_optional_control_metadata_cannot_interrupt_capture(self):
        index = 0
        for control_index in (1, 2):
            for field, output_field in (('states', 'states'), ('available_actions', 'availableActions')):
                for variant in ('missing', None, 'invalid metadata', {'private': 'optional data'}, [None], True):
                    with self.subTest(control=control_index, field=field, variant=variant):
                        index += 1
                        self.event['messageId'] = 'msg_' + format(index, '026X')
                        self.claim['messageId'] = self.event['messageId']
                        self.claim['metadata']['messageId'] = self.event['messageId']
                        self.db.execute('UPDATE message SET message_id=?', (self.event['messageId'],))
                        self.db.execute('UPDATE audit_event SET subject_id=?', (self.event['messageId'],))
                        self.db.commit(); self.write_history()
                        envelope = test_wake.snapshot()
                        children = envelope['data']['tree']['children'][0]['children']
                        children[1].update(states=['focused'], available_actions=['SetValue'])
                        children[2]['available_actions'] = ['Click']
                        control = children[control_index]
                        if variant == 'missing': control.pop(field, None)
                        else: control[field] = variant
                        # Preserve the pre-diagnostic observer's accepted input boundary.
                        receipt.wake.observe(envelope, {'windowId': 'w-1', 'conversationMarker': 'unused'}, require_marker=False)
                        result = self.capture(envelope=envelope)
                        self.assertEqual(result['status'], 'CAPTURED')
                        saved = receipt.auto_wake.read_private(receipt.request_path(self.config, self.event['messageId']))
                        candidate = saved['controls']['composerCandidates' if control_index == 1 else 'sendCandidates'][0]
                        self.assertIsNone(candidate[output_field])
                        if field == 'states': self.assertIsNone(candidate['enabled'])
                        if control_index == 2 and field == 'states': self.assertIsNone(saved['idle']['sendEnabled'])
                        self.assertNotEqual(saved['reason'], 'CAPTURE_MAY_HAVE_OCCURRED')
                        self.assertNotIn('optional data', json.dumps(saved))


    def test_unknown_control_metadata_never_persists_in_success_or_failure_receipts(self):
        cases = [('composer', 'captured'), ('composer', 'ambiguous'),
                 ('send', 'captured'), ('send', 'ambiguous'), ('stop', 'busy')]
        secret = 'SYNTHETIC_PRIVATE_METADATA_6E9C4B'
        for index, (control_name, outcome) in enumerate(cases):
            for offset, (field, safe_value, output_field) in enumerate((
                    ('states', 'focused', 'states'), ('available_actions', 'Click', 'availableActions'))):
                with self.subTest(control=control_name, outcome=outcome, field=field):
                    self.event['messageId'] = 'msg_' + format(1000 + 2 * index + offset, '026X')
                    self.claim['messageId'] = self.event['messageId']
                    self.claim['metadata']['messageId'] = self.event['messageId']
                    self.db.execute('UPDATE message SET message_id=?', (self.event['messageId'],))
                    self.db.execute('UPDATE audit_event SET subject_id=?', (self.event['messageId'],))
                    self.db.commit(); self.write_history()
                    envelope = test_wake.snapshot()
                    children = envelope['data']['tree']['children'][0]['children']
                    if control_name == 'stop':
                        children.append({'role': 'button', 'name': '停止生成'})
                        control = children[-1]
                    else:
                        control = children[1 if control_name == 'composer' else 2]
                    if field == 'states' and control_name == 'send': safe_value = 'disabled'
                    control[field] = [safe_value, secret]
                    if outcome == 'ambiguous': children.append(dict(children[2]))
                    result = self.capture(envelope=envelope)
                    self.assertEqual(result['status'], 'CAPTURED' if outcome == 'captured' else 'UNAVAILABLE')
                    path = receipt.request_path(self.config, self.event['messageId'])
                    raw = path.read_bytes()
                    self.assertNotIn(secret.encode(), raw)
                    saved = receipt.auto_wake.read_private(path)
                    key = {'composer': 'composerCandidates', 'send': 'sendCandidates', 'stop': 'stopCandidates'}[control_name]
                    self.assertIsNone(saved['controls'][key][0][output_field])
                    if field == 'states': self.assertIsNone(saved['controls'][key][0]['enabled'])
                    if control_name == 'send' and field == 'states': self.assertIsNone(saved['idle']['sendEnabled'])


    def test_known_macos_control_metadata_is_preserved_in_receipt(self):
        # The values come from agent-desktop v1.0.2's macOS snapshot contract.
        states = ['focused', 'disabled', 'secure', 'expanded', 'checked', 'indeterminate',
                  'selected', 'hidden', 'busy', 'modal', 'required', 'pressed', 'readonly', 'offscreen']
        actions = ['Click', 'Toggle', 'RightClick', 'ScrollTo', 'Scroll', 'SetValue',
                   'Select', 'SetFocus', 'TypeText', 'Expand', 'Collapse']
        envelope = test_wake.snapshot()
        composer = envelope['data']['tree']['children'][0]['children'][1]
        composer.update(states=states, available_actions=actions)
        self.assertEqual(self.capture(envelope=envelope)['status'], 'CAPTURED')
        saved = receipt.auto_wake.read_private(receipt.request_path(self.config, self.event['messageId']))
        diagnostic = saved['controls']['composerCandidates'][0]
        self.assertEqual(diagnostic['states'], sorted(states))
        self.assertEqual(diagnostic['availableActions'], sorted(actions))
        self.assertFalse(diagnostic['enabled'])


    def test_current_idle_draft_and_legacy_failure_records_are_safe(self):
        view = receipt.wake.observe(test_wake.snapshot(), {'windowId': 'w-1', 'conversationMarker': 'unused'}, require_marker=False)
        self.assertEqual((view['draft'], view['send']['states']), ('', ['disabled']))
        self.assertEqual(self.capture()['status'], 'CAPTURED')
        path = receipt.request_path(self.config, self.event['messageId'])
        saved = receipt.auto_wake.read_private(path)
        self.assertEqual(saved['idle']['sendEnabled'], False)
        self.assertEqual(saved['idle']['stopCandidates'], 0)
        self.assertEqual(saved['draftState'], 'EMPTY')
        self.assertNotIn('draft', saved)
        # A subsequent observation must not reinterpret or backfill a persisted old format.
        legacy = dict(saved)
        legacy.update(status='UNAVAILABLE', reason='INPUT_OR_SEND_AMBIGUOUS')
        legacy.pop('target', None); legacy.pop('observedAt', None)
        receipt.wake.write_state(path, legacy)
        self.assertEqual(self.capture()['status'], 'UNAVAILABLE')
        self.assertEqual(receipt.auto_wake.read_private(path), legacy)

    def test_diagnostics_cover_unknown_draft_busy_missing_area_and_control_shape(self):
        kinds = ('draft-absent', 'draft-null', 'draft', 'busy', 'missing-area', 'duplicate-area')
        for index, kind in enumerate(kinds):
            with self.subTest(kind=kind):
                self.event['messageId'] = 'msg_' + '6789AB'[index] * 26
                self.claim['messageId'] = self.event['messageId']
                self.claim['metadata']['messageId'] = self.event['messageId']
                self.db.execute('UPDATE message SET message_id=?', (self.event['messageId'],))
                self.db.execute('UPDATE audit_event SET subject_id=?', (self.event['messageId'],))
                self.db.commit(); self.write_history()
                envelope = test_wake.snapshot(title='pi-chat-exchange@3')
                area = envelope['data']['tree']['children'][0]
                if kind == 'draft-absent': area['children'][1].pop('value')
                elif kind == 'draft-null': area['children'][1]['value'] = None
                elif kind == 'draft': area['children'][1]['value'] = 'private draft'
                elif kind == 'busy': area['children'].append({'role': 'button', 'name': '停止生成'})
                elif kind == 'missing-area': envelope['data']['tree']['children'].clear()
                else: envelope['data']['tree']['children'].append(dict(area))
                result = self.capture(envelope=envelope)
                self.assertEqual(result['status'], 'UNAVAILABLE')
                saved = receipt.auto_wake.read_private(receipt.request_path(self.config, self.event['messageId']))
                diagnostic = saved['controls']
                self.assertNotIn('private draft', json.dumps(saved))
                if kind == 'draft': self.assertEqual((saved['draftState'], saved['draftLength']), ('NONEMPTY', 13))
                elif kind in ('draft-absent', 'draft-null'): self.assertEqual(saved['draftState'], 'UNKNOWN')
                elif kind == 'busy': self.assertEqual(len(diagnostic['stopCandidates']), 1)
                else: self.assertEqual(diagnostic['webareaCount'], 0 if kind == 'missing-area' else 2)

        # Controls-only synthetic projection: no dependency on private capture files.
        envelope = test_wake.snapshot()
        children = envelope['data']['tree']['children'][0]['children']
        children[1]['available_actions'] = ['SetValue', 'TypeText', 'SetFocus', 'ScrollTo', 'RightClick', 'Click']
        children[2]['states'] = ['disabled']
        diagnostic = receipt.wake.control_diagnostics(envelope)
        self.assertEqual([len(diagnostic[key]) for key in ('composerCandidates', 'sendCandidates', 'stopCandidates')], [1, 1, 0])
        self.assertEqual((diagnostic['draftState'], diagnostic['draftLength']), ('EMPTY', 0))
        self.assertEqual(diagnostic['composerCandidates'][0]['availableActions'], ['Click', 'RightClick', 'ScrollTo', 'SetFocus', 'SetValue', 'TypeText'])
        self.assertEqual(diagnostic['sendCandidates'][0]['enabled'], False)




    def test_new_receipt_samples_desktop_target_and_never_recaptures_later(self):
        result = self.capture()
        self.assertEqual(result['status'], 'CAPTURED')
        saved = receipt.auto_wake.read_private(receipt.request_path(self.config, self.event['messageId']))
        self.assertEqual(saved['target']['title'], 'Target A')
        self.assertEqual(saved['selection'], 'DESKTOP_AT_INTAKE_NOT_ACTUAL_ORIGIN')
        self.capture(title='Different B')
        again = receipt.auto_wake.read_private(receipt.request_path(self.config, self.event['messageId']))
        self.assertEqual(again, saved)

    def test_late_old_or_missing_receipt_cannot_be_backfilled(self):
        self.config['conversationGuard']['captureAfterAuditSequence'] = 1
        with self.assertRaisesRegex(ValueError, 'BEFORE_CAPTURE_CUTOFF'):
            self.capture()
        self.config['conversationGuard']['captureAfterAuditSequence'] = 0
        self.claim['admittedAt'] -= 60000
        self.write_history()
        with self.assertRaisesRegex(ValueError, 'CAPTURE_TOO_LATE'):
            self.capture()
        Path(self.config['nativeSessionFile']).write_text(json.dumps({'type': 'session', 'id': 'native-runtime'}) + '\n')
        with self.assertRaisesRegex(ValueError, 'INBOUND_CLAIM_REQUIRED'):
            self.capture()

    def test_mobile_origin_is_not_inferred_from_payload_or_foreground_identity(self):
        self.capture(title='Desktop B')
        saved = receipt.auto_wake.read_private(receipt.request_path(self.config, self.event['messageId']))
        self.assertEqual(saved['target']['title'], 'Desktop B')
        self.assertNotIn('sourceTitle', saved)
        self.assertEqual(saved['selection'], 'DESKTOP_AT_INTAKE_NOT_ACTUAL_ORIGIN')

    def test_prepare_requires_successful_receive_and_preserves_original_request_relation(self):
        self.capture()
        with mock.patch.object(receipt.auto_wake, 'resolve_runtime', return_value=self.runtime):
            result = receipt.prepare(self.event['messageId'], 'task-label', 'unique-reply-key', self.config,
                                     'native-runtime', 'pi/session-test')
            self.assertEqual(result['status'], 'PREPARED')
            with self.assertRaisesRegex(ValueError, 'REPLY_KEY_CONFLICT'):
                receipt.prepare(self.event['messageId'], 'other-label', 'unique-reply-key', self.config,
                                'native-runtime', 'pi/session-test')
        self.write_history(received=False)
        with mock.patch.object(receipt.auto_wake, 'resolve_runtime', return_value=self.runtime), \
                self.assertRaisesRegex(ValueError, 'REQUEST_NOT_RECEIVED'):
            receipt.prepare(self.event['messageId'], 'task-label', 'other-key', self.config,
                            'native-runtime', 'pi/session-test')

    def test_missing_reply_mapping_stays_suppressed(self):
        self.db.execute("UPDATE message SET idempotency_key='not-prepared'")
        self.db.commit()
        self.assertIsNone(receipt.lookup_reply(self.event, self.config, self.runtime))

    def test_same_title_other_title_duplicate_window_and_changed_process(self):
        self.capture()
        target = receipt.auto_wake.read_private(receipt.request_path(self.config, self.event['messageId']))['target']
        windows = [{'id': 'w-1', 'pid': 5, 'process_instance': 'generation'}]
        receipt.verify_view(target, windows, test_wake.snapshot(title='Target A'))
        for title in ('Other B', '', 'Renamed A'):
            with self.subTest(title=title), self.assertRaises(ValueError):
                receipt.verify_view(target, windows, test_wake.snapshot(title=title))
        with self.assertRaises(ValueError):
            receipt.verify_view(target, windows * 2, test_wake.snapshot(title='Target A'))
        with self.assertRaises(ValueError):
            receipt.verify_view(target, [dict(windows[0], process_instance='new')], test_wake.snapshot(title='Target A'))

    def test_changed_title_before_submit_is_refused_even_with_button_consent(self):
        self.capture()
        target = receipt.auto_wake.read_private(receipt.request_path(self.config, self.event['messageId']))['target']
        windows = [{'id': 'w-1', 'pid': 5, 'process_instance': 'generation'}]
        receipt.verify_view(target, windows, test_wake.snapshot(title='Target A'))
        with self.assertRaisesRegex(ValueError, 'TARGET_TITLE_MISMATCH'):
            receipt.verify_view(target, windows, test_wake.snapshot(title='B'))


if __name__ == '__main__':
    unittest.main()
