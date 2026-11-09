#!/usr/bin/env python3
"""Opt-in metadata ownership workflow. This is not native conversation isolation.

Callers own CE admission: associate accepts an actual CREATED send result, and
feedback accepts only the envelope returned by native CE receive for that text.
These methods never discover or read business payloads. Registration confirmation
must come from an explicit user statement, never a title, task label or memory.
"""
import contextlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid

import auto_wake
import notification
import wake

MESSAGE = r'msg_[A-Z0-9]{26}'
PROJECTION_FIELDS = {'schemaVersion', 'exchangeId', 'requestMessageId', 'messageId', 'from', 'to',
                     'projectLabel', 'taskOwner', 'ownerStatus', 'probeId'}
OUTCOMES = {'MATCH', 'WRONG_CONVERSATION', 'UNVERIFIED'}


def identifier(value, pattern=MESSAGE):
    if not isinstance(value, str) or not re.fullmatch(pattern, value):
        raise ValueError('IDENTIFIER_INVALID')
    return value


def label(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 120 or any(ord(c) < 32 for c in value):
        raise ValueError('OWNER_LABEL_INVALID')
    return value


def validate_projection(value):
    if not isinstance(value, dict) or set(value) != PROJECTION_FIELDS or type(value['schemaVersion']) is not int or value['schemaVersion'] != 1:
        raise ValueError('PROJECTION_INVALID')
    for field in ('requestMessageId', 'messageId'):
        identifier(value[field])
    identifier(value['exchangeId'], r'ho_[A-Z0-9]{26}')
    identifier(value['from'], r'pi/[A-Za-z0-9-]{1,64}')
    identifier(value['to'], r'chatgpt/[A-Za-z0-9-]{1,64}')
    identifier(value['probeId'], r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}')
    if value['ownerStatus'] == 'REGISTERED':
        label(value['projectLabel'])
        label(value['taskOwner'])
    elif value['ownerStatus'] not in ('UNVERIFIED', 'CONFLICT') or value['projectLabel'] is not None or value['taskOwner'] is not None:
        raise ValueError('OWNER_STATUS_INVALID')
    return value


def decide(metadata, current_chat):
    validate_projection(metadata)
    # current_chat is an explicit user-confirmed convention supplied by this chat,
    # not a claimed native Conversation ID and not copied from metadata or prompt.
    if (metadata['ownerStatus'] != 'REGISTERED' or not isinstance(current_chat, dict)
            or set(current_chat) != {'projectLabel', 'taskOwner', 'confirmation'}
            or current_chat['confirmation'] != 'EXPLICIT_USER'):
        return 'UNVERIFIED'
    try:
        label(current_chat['projectLabel'])
        label(current_chat['taskOwner'])
    except ValueError:
        return 'UNVERIFIED'
    return 'MATCH' if all(current_chat[k] == metadata[k] for k in ('projectLabel', 'taskOwner')) else 'WRONG_CONVERSATION'


def prompt(metadata, *, metadata_only=False):
    p = validate_projection(metadata)
    correlation = {key: p[key] for key in ('messageId', 'requestMessageId', 'probeId')}
    if metadata_only:
        return (
            '[CE-TASK-OWNER-CHECK v1] CHECK_ONLY；关联数据：'
            + json.dumps({'protocol': 'ce.task-owner-feedback.v1', **correlation},
                         sort_keys=True, separators=(',', ':'))
            + '。仅调用一次 ce_task_owner，参数只用关联数据的 messageId。'
            '仅凭本聊天用户明确确认的项目标签与已登记 task owner 比对；'
            '不得用查询、窗口、前台、Task ID、记忆或本提示推断本聊天身份；无原生 Conversation-ID 隔离保证。'
            '缺确认、未登记、工具不可用、拒绝或冲突为 UNVERIFIED；明确不匹配为 WRONG_CONVERSATION；'
            '仅 REGISTERED 且两项明确匹配为 MATCH。MATCH 后仍不得读取任何消息正文，禁用 ce_read_payload 及代读。'
            '所有结果均禁止扫描 Inbox、ACK、业务执行或普通 CE 回复。'
            '仅用现有 ce_send 向 ' + p['from'] + ' 发送一次 JSON：原样关联数据加 outcome 字段，值仅取实际结果。'
            'idempotencyKey=ce-owner-feedback:<probeId>:<outcome>，尖括号替换为实际值。'
            '查询或发送失败、不确定时停止，不重试、不绕过。')
    return (
        '[CE-TASK-OWNER-CHECK v1] 仅做一次元数据归属检查。关联数据：'
        + json.dumps(correlation, sort_keys=True, separators=(',', ':'))
        + '。先调用 ce_task_owner，参数仅为 messageId=' + p['messageId']
        + '。使用本聊天中用户明确确认的项目标签及明确登记的 task owner 比对查询结果；'
        '不得把查询结果、窗口标题、前台状态、Task ID、记忆或本提示当作本聊天身份。'
        '本流程没有原生 ChatGPT Conversation-ID 隔离保证。缺少明确确认、工具不可用、拒绝或冲突均为 UNVERIFIED。'
        '不匹配为 WRONG_CONVERSATION，不得读取 payload；只有 REGISTERED 且两项明确匹配才为 MATCH。'
        + ('本次仅核查元数据，MATCH 后仍不得读取任何消息正文、不得调用 ce_read_payload 或其他工具代读。'
           if metadata_only else '仅 MATCH 才可调用 ce_read_payload 读取上述唯一 Message ID；拒绝则停止，不得绕过。')
        + '不得扫描 Inbox、自动 ACK、执行业务内容或生成普通 CE 结果回复。'
        '仅用现有 ce_send 向 ' + p['from'] + ' 发送一次结构化检查反馈：'
        + json.dumps({'protocol': 'ce.task-owner-feedback.v1', **correlation, 'outcome': 'MATCH|WRONG_CONVERSATION|UNVERIFIED'},
                     sort_keys=True, separators=(',', ':'))
        + '，outcome 只取实际结果；idempotencyKey 使用 ce-owner-feedback:' + p['probeId']
        + ':实际结果。发送失败或不确定时停止，不重试。')


class Store:
    def __init__(self, root, scope):
        if not isinstance(scope, dict) or set(scope) != {'exchangeId', 'from', 'to'}:
            raise ValueError('SCOPE_INVALID')
        identifier(scope['exchangeId'], r'ho_[A-Z0-9]{26}')
        identifier(scope['from'], r'pi/[A-Za-z0-9-]{1,64}')
        identifier(scope['to'], r'chatgpt/[A-Za-z0-9-]{1,64}')
        self.scope = dict(scope)
        self.root = auto_wake.private_dir(root)
        for name in ('owners', 'metadata', 'state', 'terminal'):
            auto_wake.private_dir(self.root / name)
        with self.locked():
            path = self.root / 'scope.json'
            if os.path.lexists(path):
                if auto_wake.read_private(path) != self.scope:
                    raise ValueError('REGISTRY_SCOPE_CHANGED')
            else:
                self.write(path, self.scope)

    @contextlib.contextmanager
    def locked(self):
        with auto_wake.locked(self.root / '.ownership.lock', wait_seconds=5):
            yield

    @staticmethod
    def write(path, value):
        # Existing journal utility fsyncs the file and directory; never follow a
        # planted destination or temp symlink at this private local boundary.
        for candidate in (path, path.with_suffix('.tmp')):
            if os.path.lexists(candidate) and candidate.is_symlink():
                raise ValueError('PRIVATE_STATE_REQUIRED')
        wake.write_state(path, value)

    def register(self, request_id, project_label, task_owner, *, confirmation, new_request_only=False):
        """Register the explicitly assigned owner label; it may equal the project label."""
        identifier(request_id)
        label(project_label)
        label(task_owner)
        if confirmation != 'EXPLICIT_USER':
            raise ValueError('EXPLICIT_OWNER_CONFIRMATION_REQUIRED')
        registration = {'projectLabel': project_label, 'taskOwner': task_owner, 'ownerStatus': 'REGISTERED'}
        with self.locked():
            path = self.root / 'owners' / (request_id + '.json')
            if new_request_only:
                if os.path.lexists(path):
                    prior = auto_wake.read_private(path)
                    if prior != registration:
                        raise ValueError('CHECK_ONLY_OWNER_ALREADY_REGISTERED')
                    return prior
                intent = self.root / 'check-only-intents' / ('request-' + request_id + '.json')
                if os.path.lexists(intent):
                    raise ValueError('CHECK_ONLY_EXISTING_INTENT')
                # Never promote an already-created outgoing projection retroactively.
                for projection_path in (self.root / 'metadata').glob('msg_*.json'):
                    if self.projection(projection_path.stem)['requestMessageId'] == request_id:
                        raise ValueError('CHECK_ONLY_EXISTING_PROJECTION')
                self.write(path, registration)
                return registration
            if os.path.lexists(path):
                prior = auto_wake.read_private(path)
                if prior != registration:
                    registration = {'projectLabel': None, 'taskOwner': None, 'ownerStatus': 'CONFLICT'}
            self.write(path, registration)
            # A later conflicting registration invalidates existing projections;
            # ordinary registration never repairs conflict or binds another task.
            for projection_path in (self.root / 'metadata').glob('msg_*.json'):
                p = self.projection(projection_path.stem)
                if p['requestMessageId'] == request_id and p['ownerStatus'] != registration['ownerStatus']:
                    self.write(projection_path, {**p, **registration})
        return registration

    def associate(self, request_id, actual_created):
        identifier(request_id)
        if (not isinstance(actual_created, dict) or set(actual_created) != {'messageId', 'disposition', *self.scope}
                or actual_created['disposition'] != 'CREATED'
                or any(actual_created[k] != v for k, v in self.scope.items())):
            raise ValueError('ACTUAL_CREATED_SCOPED_MESSAGE_REQUIRED')
        outgoing_id = identifier(actual_created['messageId'])
        if outgoing_id == request_id:
            raise ValueError('ORIGINAL_AND_REPLY_MUST_DIFFER')
        with self.locked():
            path = self.root / 'metadata' / (outgoing_id + '.json')
            if os.path.lexists(path):
                p = self.projection(outgoing_id)
                if p['requestMessageId'] != request_id:
                    raise ValueError('OUTGOING_ASSOCIATION_CONFLICT')
                return p
            owner_path = self.root / 'owners' / (request_id + '.json')
            owner = (auto_wake.read_private(owner_path) if os.path.lexists(owner_path) else
                     {'ownerStatus': 'UNVERIFIED', 'projectLabel': None, 'taskOwner': None})
            p = validate_projection({'schemaVersion': 1, **self.scope, 'requestMessageId': request_id,
                                     'messageId': outgoing_id, 'probeId': str(uuid.uuid4()), **owner})
            self.write(path, p)
            return p

    def projection(self, message_id):
        identifier(message_id)
        p = validate_projection(auto_wake.read_private(self.root / 'metadata' / (message_id + '.json')))
        if p['messageId'] != message_id or any(p[k] != v for k, v in self.scope.items()):
            raise ValueError('PROJECTION_SCOPE_MISMATCH')
        return p

    def state(self, message_id):
        identifier(message_id)
        path = self.root / 'state' / (message_id + '.json')
        if os.path.lexists(path):
            return auto_wake.read_private(path)
        return {'automatic': 'NOT_ATTEMPTED', 'manual': 'NOT_ATTEMPTED', 'read': 'NOT_ATTEMPTED',
                'feedback': None, 'notification': 'NOT_ATTEMPTED', 'notificationEligible': False,
                'suppressOrdinaryReply': True}

    def save(self, message_id, state):
        self.write(self.root / 'state' / (message_id + '.json'), state)

    def fetch(self, message_id, current_chat, execute_tool):
        with self.locked():
            outcome = decide(self.projection(message_id), current_chat)
            if outcome != 'MATCH':
                return {'outcome': outcome, 'payloadRead': 'NOT_ATTEMPTED', 'suppressOrdinaryReply': True}
            state = self.state(message_id)
            if state['read'] != 'NOT_ATTEMPTED':
                return {'outcome': outcome, 'payloadRead': state['read'], 'suppressOrdinaryReply': True}
            state['read'] = 'UNKNOWN'
            self.save(message_id, state)
            result = execute_tool('ce_read_payload', {'messageId': message_id})
            if isinstance(result, dict) and result.get('isError') is True:
                return {'outcome': outcome, 'payloadRead': 'UNKNOWN', 'suppressOrdinaryReply': True}
            state['read'] = 'OBSERVED'
            self.save(message_id, state)
            return {'outcome': outcome, 'payloadRead': 'OBSERVED', 'result': result, 'suppressOrdinaryReply': True}

    def _record_terminal(self, received_id, projection):
        # Caller holds the registry lock: one feedback MID cannot name two probes.
        terminal = self.root / 'terminal' / (received_id + '.json')
        marker = {'messageId': projection['messageId'], 'probeId': projection['probeId']}
        if os.path.lexists(terminal):
            if auto_wake.read_private(terminal) != marker:
                raise ValueError('FEEDBACK_RECEIPT_CONFLICT')
        else:
            self.write(terminal, marker)

    def record_terminal(self, received_id, outgoing_id, probe_id):
        identifier(received_id)
        with self.locked():
            projection = self.projection(outgoing_id)
            if projection['probeId'] != probe_id:
                raise ValueError('FEEDBACK_CORRELATION_DENIED')
            self._record_terminal(received_id, projection)

    def feedback(self, received_envelope, body, *, allow_notification=True):
        if (not isinstance(body, dict) or set(body) != {'protocol', 'probeId', 'requestMessageId', 'messageId', 'outcome'}
                or body['protocol'] != 'ce.task-owner-feedback.v1' or body['outcome'] not in OUTCOMES):
            raise ValueError('FEEDBACK_PROTOCOL_INVALID')
        if (not isinstance(received_envelope, dict) or set(received_envelope) != {'messageId', *self.scope}
                or received_envelope['exchangeId'] != self.scope['exchangeId']
                or received_envelope['from'] != self.scope['to'] or received_envelope['to'] != self.scope['from']):
            raise ValueError('FEEDBACK_SCOPE_DENIED')
        identifier(received_envelope['messageId'])
        with self.locked():
            try:
                p = self.projection(body['messageId'])
            except FileNotFoundError:
                raise ValueError('FEEDBACK_CORRELATION_DENIED') from None
            if any(body[k] != p[k] for k in ('probeId', 'requestMessageId')):
                raise ValueError('FEEDBACK_CORRELATION_DENIED')
            # Every correlated MID remains terminal, including reordered feedback.
            self._record_terminal(received_envelope['messageId'], p)
            state = self.state(p['messageId'])
            if state['feedback'] is not None:
                if not allow_notification and state['notificationEligible']:
                    state['notificationEligible'] = False
                    self.save(p['messageId'], state)
                return {**state, 'duplicateOrReordered': True}
            state['feedback'] = body['outcome']
            state['feedbackMessageId'] = received_envelope['messageId']
            state['notificationEligible'] = (allow_notification and body['outcome'] in ('WRONG_CONVERSATION', 'UNVERIFIED')
                                             and state['automatic'] == 'OBSERVED'
                                             and state['manual'] == 'NOT_ATTEMPTED'
                                             and state['notification'] == 'NOT_ATTEMPTED')
            self.save(p['messageId'], state)
            return state

    def attempt(self, message_id, config, desktop, *, manual=False, authority=None, metadata_only=False):
        with self.locked():
            p = self.projection(message_id)
            state = self.state(message_id)
            key = 'manual' if manual else 'automatic'
            # An out-of-order feedback is terminal; it cannot start an automatic
            # probe. Manual entry is private to the durably consumed button path.
            allowed = (state['manual'] == 'CONSENT_CONSUMED' and state['automatic'] != 'UNKNOWN' if manual else
                       state['automatic'] == 'NOT_ATTEMPTED' and state['feedback'] is None)
            if not allowed:
                return {'noticeSubmission': state[key] if state[key] in ('OBSERVED', 'UNKNOWN') else 'NOT_ATTEMPTED'}
            text = prompt(p, metadata_only=metadata_only)
            state[key] = 'OBSERVING'
            state[key + 'Phase'] = 'OBSERVING'
            self.save(message_id, state)
            cfg = dict(config, executionEnd=time.monotonic() + min(120, config.get('maxWaitSeconds', 30)))
            phase = 'OBSERVING'
            try:
                if authority:
                    authority()
                first = wake.observe(desktop.snapshot(), cfg, require_marker=False)
                if first['draft']:
                    raise ValueError('NONEMPTY_DRAFT')
                # Resolve fresh references and recheck empty/idle just before input.
                view = wake.observe(desktop.snapshot(), cfg, require_marker=False)
                if view['draft']:
                    raise ValueError('NONEMPTY_DRAFT')
                if authority:
                    authority()
                if metadata_only and callable(getattr(desktop, 'prepare_fill', None)):
                    view['input']['ref_id'] = desktop.prepare_fill(text)
                state[key] = 'UNKNOWN'
                phase = 'INPUT_MAY_HAVE_OCCURRED'
                state[key + 'Phase'] = phase
                self.save(message_id, state)
                desktop.fill(view['input']['ref_id'], text)
                prepare_submit = getattr(desktop, 'prepare_submit', None) if metadata_only else None
                if callable(prepare_submit):
                    send_ref = prepare_submit(text)
                    state[key + 'InputProof'] = desktop.input_proof
                else:
                    view = wake.observe(desktop.snapshot(), cfg, require_marker=False)
                    if view['draft'] != text or 'disabled' in view['send'].get('states', []):
                        raise ValueError('DRAFT_OR_SEND_READBACK_MISMATCH')
                    send_ref = view['send']['ref_id']
                if authority:
                    authority()
                phase = 'SUBMIT_MAY_HAVE_OCCURRED'
                state[key + 'Phase'] = phase
                self.save(message_id, state)
                desktop.submit(send_ref)
                view = wake.observe(desktop.snapshot(), cfg, allow_busy=True, require_marker=False)
                if view['draft'] or text not in view['texts']:
                    raise ValueError('SUBMISSION_UNVERIFIED')
                state[key] = 'OBSERVED'
                state[key + 'Phase'] = 'NOTICE_OBSERVED'
            except (ValueError, OSError, subprocess.SubprocessError) as error:
                code = str(error)
                state[key + 'Reason'] = code if isinstance(error, ValueError) and re.fullmatch(r'[A-Z][A-Z0-9_]{1,79}', code) else type(error).__name__
                if metadata_only:
                    # A final desktop guard may reject after the durable marker.
                    # Its dispatch flag distinguishes that from a lost result.
                    if phase == 'SUBMIT_MAY_HAVE_OCCURRED' and getattr(desktop, 'submit_attempted', None) is False:
                        phase = 'INPUT_MAY_HAVE_OCCURRED'
                    if phase == 'INPUT_MAY_HAVE_OCCURRED' and getattr(desktop, 'input_attempted', None) is False:
                        phase = 'OBSERVING'
                    state[key + 'Phase'] = phase
                if phase == 'OBSERVING':
                    state[key] = 'SUPPRESSED'
            if metadata_only:
                # These flags prove command dispatch was attempted, not OS delivery.
                for action in ('input', 'submit'):
                    attempted = getattr(desktop, action + '_attempted', None)
                    if type(attempted) is bool:
                        state[key + action.title() + 'Attempted'] = attempted
            self.save(message_id, state)
            return {'noticeSubmission': state[key] if state[key] in ('OBSERVED', 'UNKNOWN') else 'NOT_ATTEMPTED'}

    def notify(self, message_id, config, notifier_config, *, notifier=None, desktop_factory=None, authority=None):
        with self.locked():
            p = self.projection(message_id)
            state = self.state(message_id)
            if not state['notificationEligible'] or state['notification'] != 'NOT_ATTEMPTED':
                return state
            state['notification'] = 'UNKNOWN'
            state['notificationEligible'] = False
            self.save(message_id, state)
            group = 'ce-owner:' + message_id + ':' + p['probeId']
            request = {'title': 'Pi → ChatGPT', 'message': '请手动切换到已确认归属的对话，再点击检查。' + message_id,
                       'group': group, 'action': notifier_config['actionTitle'], 'timeout': notifier_config['timeoutSeconds']}
        notify = notifier or (lambda value: notification.terminal_notifier(value, notifier_config['terminalNotifier']))
        try:
            outcome = notify(request)
        except (OSError, subprocess.SubprocessError):
            return self.state(message_id)
        with self.locked():
            state = self.state(message_id)
            if outcome != notifier_config['actionTitle']:
                state['notification'] = 'DISMISSED' if outcome == '@CLOSED' else 'UNKNOWN'
                self.save(message_id, state)
                return state
            state['notification'] = 'ACTION_BUTTON'
            state['manual'] = 'CONSENT_CONSUMED'
            self.save(message_id, state)
        # Factory must freshly select/recheck the current unique window; never
        # switch chats or reuse a prior ref/window from before human consent.
        try:
            desktop = desktop_factory()
            self.attempt(message_id, config, desktop, manual=True, authority=authority)
        except (ValueError, OSError, subprocess.SubprocessError):
            with self.locked():
                state = self.state(message_id)
                state['manual'] = 'UNKNOWN'
                self.save(message_id, state)
        return self.state(message_id)
