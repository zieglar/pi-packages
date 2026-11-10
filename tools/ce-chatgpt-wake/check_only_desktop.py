"""Foreground-only desktop adapter for an explicitly prepared CHECK_ONLY action."""
import hashlib
import tempfile
from pathlib import Path

import auto_wake
import wake


class ForegroundDesktop(wake.ChatGptCli):
    input_attempted = False
    submit_attempted = False

    def call(self, args):
        owner_check = self.config.get('checkRegisteredOwner')
        if owner_check is not None:
            if not callable(owner_check):
                raise ValueError('CHECK_REGISTERED_OWNER_REQUIRED')
            owner_check()
        # Mark entry to the command dispatcher only after its final owner gate.
        if args[0] == 'set-value':
            self.input_attempted = True
        elif args[0] == 'click':
            self.submit_attempted = True
        return super().call(args)

    def foreground_window(self):
        windows = self.call(['list-windows', '--app', 'ChatGPT'])['data']
        if not isinstance(windows, list) or len(windows) != 1:
            raise ValueError('UNIQUE_CHATGPT_WINDOW_REQUIRED')
        window = windows[0]
        if (not isinstance(window, dict) or not isinstance(window.get('id'), str) or not window['id']
                or type(window.get('pid')) is not int or window['pid'] <= 0
                or not isinstance(window.get('process_instance'), str) or not window['process_instance']):
            raise ValueError('WINDOW_METADATA_INVALID')
        # Scoped AX focus only describes the app's own focused window. Global
        # inventory joins focus to the authoritative frontmost application.
        global_windows = self.call(['list-windows'])['data']
        if (not isinstance(global_windows, list) or any(
                not isinstance(w, dict) or type(w.get('is_focused')) is not bool for w in global_windows)):
            raise ValueError('WINDOW_METADATA_INVALID')
        focused = [w for w in global_windows if w['is_focused']]
        if len(focused) != 1 or any(focused[0].get(k) != window[k] for k in ('id', 'pid', 'process_instance')):
            raise ValueError('CHATGPT_NOT_FOREGROUND')
        for candidate in (window, focused[0]):
            if candidate.get('accessible') is not True or candidate.get('visible') is not True:
                raise ValueError('CHATGPT_WINDOW_UNAVAILABLE')
        # Global inventory may omit unknown minimization; the app record must prove it is false.
        if (window.get('minimized') is not False
                or ('minimized' in focused[0] and focused[0]['minimized'] is not False)):
            raise ValueError('CHATGPT_WINDOW_UNAVAILABLE')
        return window

    def current_window(self):
        window = self.foreground_window()
        if (window['id'] != self.config['windowId'] or window['pid'] != self.config['pid']
                or window['process_instance'] != self.config['processInstance']):
            raise ValueError('CHATGPT_PROCESS_OR_WINDOW_CHANGED')

    def snapshot(self):
        self.current_window()
        envelope = self.call(['snapshot', '--app', 'ChatGPT', '--window-id', self.config['windowId'],
                              '--compact', '--max-depth', '30', '--timeout-ms', '8000'])
        # Post-submit observation may see generation in progress. Mutations below
        # independently require idle controls through observe's strict default.
        view = wake.observe(envelope, self.config, allow_busy=True, require_marker=False)
        raw = view['input'].get('value')
        if not isinstance(raw, str):
            raise ValueError('EDITOR_VALUE_UNKNOWN')
        ref = view['input'].get('ref_id')
        if not isinstance(ref, str) or not ref:
            raise ValueError('EDITOR_REF_UNKNOWN')
        value = self.call(['get', ref, '--property', 'value']).get('data')
        if (not isinstance(value, dict) or value.get('ref') != ref or value.get('property') != 'value'
                or not isinstance(value.get('value'), str) or value['value'] != raw):
            raise ValueError('EDITOR_READBACK_MISMATCH')
        # This exact empty representation was observed in the installed app. A
        # typed copy with an enabled Send button is a draft and cannot be cleared.
        if raw == '询问 ChatGPT\n' and (view['send'] is None or self.send_enabled(view['send'].get('ref_id'))):
            raise ValueError('NONEMPTY_DRAFT')
        return envelope

    def send_enabled(self, ref):
        if not isinstance(ref, str) or not ref:
            raise ValueError('SEND_REF_UNKNOWN')
        data = self.call(['is', ref, '--property', 'enabled']).get('data')
        if (not isinstance(data, dict) or data.get('ref') != ref or data.get('property') != 'enabled'
                or data.get('applicable') is not True or type(data.get('result')) is not bool):
            raise ValueError('SEND_ENABLED_UNKNOWN')
        return data['result']

    def prepare_fill(self, text):
        self._prepared_fill = None
        if getattr(self, '_fill_consumed', False):
            raise ValueError('INPUT_ALREADY_CONSUMED')
        if not isinstance(text, str) or not text:
            raise ValueError('PROMPT_REQUIRED')
        view = wake.observe(self.snapshot(), self.config, require_marker=False)
        if view['input'].get('value') != '询问 ChatGPT\n':
            raise ValueError('VERIFIED_EMPTY_COMPOSER_REQUIRED')
        if self.send_enabled(view['send'].get('ref_id')):
            raise ValueError('NONEMPTY_DRAFT')
        self.config['checkAuthority']()
        self.current_window()
        self._prepared_fill = (view['input']['ref_id'], text)
        return view['input']['ref_id']

    def fill(self, ref, text):
        if getattr(self, '_fill_consumed', False):
            raise ValueError('INPUT_ALREADY_CONSUMED')
        prepared = getattr(self, '_prepared_fill', None)
        if prepared is None:
            ref = self.prepare_fill(text)
        elif prepared != (ref, text):
            raise ValueError('PREPARED_INPUT_MISMATCH')
        # Consume before dispatch: lost command results never permit a retry.
        self._fill_consumed = True
        self._prepared_fill = None
        self.config['checkAuthority']()
        self.current_window()
        view = wake.observe(self.snapshot(), self.config, require_marker=False)
        if (view['input'].get('value') != '询问 ChatGPT\n'
                or self.send_enabled(view['send'].get('ref_id'))):
            raise ValueError('PRE_INPUT_STATE_CHANGED')
        self.expected_prompt = text
        super().fill(view['input']['ref_id'], text)

    def prepare_submit(self, text):
        self._prepared_submit = None
        if getattr(self, '_submit_consumed', False):
            raise ValueError('SUBMIT_ALREADY_CONSUMED')
        if not getattr(self, 'input_attempted', False) or text != getattr(self, 'expected_prompt', None):
            raise ValueError('PRIOR_INPUT_REQUIRED')
        view = wake.observe(self.snapshot(), self.config, require_marker=False)
        if view['draft'] != text:
            raise ValueError('DRAFT_READBACK_MISMATCH')
        if not self.send_enabled(view['send'].get('ref_id')):
            raise ValueError('SEND_DISABLED')
        states = view['send'].get('states')
        if 'states' in view['send'] and (not isinstance(states, list) or 'disabled' in states):
            raise ValueError('SEND_STATE_CONFLICT')
        self.config['checkAuthority']()
        self.current_window()
        self.input_proof = {'length': len(text), 'sha256': hashlib.sha256(text.encode('utf-8')).hexdigest()}
        self._prepared_submit = view['send']['ref_id']
        return self._prepared_submit

    def submit(self, ref):
        if getattr(self, '_submit_consumed', False):
            raise ValueError('SUBMIT_ALREADY_CONSUMED')
        prepared = getattr(self, '_prepared_submit', None)
        if prepared is None:
            ref = self.prepare_submit(getattr(self, 'expected_prompt', None))
        elif prepared != ref:
            raise ValueError('PREPARED_SUBMIT_MISMATCH')
        self._submit_consumed = True
        self._prepared_submit = None
        self.config['checkAuthority']()
        self.current_window()
        view = wake.observe(self.snapshot(), self.config, require_marker=False)
        ref = view['send'].get('ref_id')
        if view['draft'] != self.expected_prompt or not self.send_enabled(ref):
            raise ValueError('PRE_SUBMIT_STATE_CHANGED')
        states = view['send'].get('states')
        if 'states' in view['send'] and (not isinstance(states, list) or 'disabled' in states):
            raise ValueError('SEND_STATE_CONFLICT')
        super().submit(ref)


def desktop_for(config):
    if not callable(config.get('checkAuthority')):
        raise ValueError('CHECK_AUTHORITY_REQUIRED')
    config['desktopTmpDir'] = tempfile.mkdtemp(prefix='ce-check-only-', dir='/private/tmp')
    config['desktopSession'] = Path(config['desktopTmpDir']).name
    cli = ForegroundDesktop(config)
    cli.env = {**auto_wake.clean_env(), 'TMPDIR': config['desktopTmpDir']}
    window = cli.foreground_window()
    config.update(windowId=window['id'], pid=window['pid'], processInstance=window['process_instance'])
    return cli
