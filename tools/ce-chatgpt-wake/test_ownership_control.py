import io
import json
import unittest
from unittest import mock

import ownership_control as control
import ownership_loop
from test_ownership_guard import IN, OUT


class ControlTests(unittest.TestCase):
    def invoke(self, body, extra):
        with mock.patch('sys.stdin', io.StringIO(body)), mock.patch('sys.stdout', new_callable=io.StringIO) as out, \
             mock.patch('sys.stderr', new_callable=io.StringIO) as err:
            code = control.main(['--config', '/synthetic', '--message-id', IN, *extra])
        return code, out.getvalue(), err.getvalue()

    def test_feedback_uses_native_received_id_and_prints_only_terminal_metadata(self):
        body = {'protocol': 'ce.task-owner-feedback.v1', 'messageId': OUT}
        with mock.patch.object(control.auto_wake, 'load_config', return_value={}), \
             mock.patch.object(control.auto_wake, 'resolve_runtime', return_value={}), \
             mock.patch.object(ownership_loop, 'store_for'), \
             mock.patch.object(ownership_loop, 'receive_feedback', return_value={'suppressOrdinaryReply': True}) as receive:
            code, out, err = self.invoke(json.dumps(body), ['--feedback'])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), {'suppressOrdinaryReply': True})
        self.assertEqual(receive.call_args.args, (IN, body, {}, {}))
        self.assertEqual(err, '')

    def test_invalid_oversized_or_duplicate_json_never_reaches_feedback(self):
        for body in ('{', '{"outcome":1,"outcome":2}', 'x' * 2049):
            with self.subTest(body=body[:20]), \
                 mock.patch.object(control.auto_wake, 'load_config', return_value={}), \
                 mock.patch.object(control.auto_wake, 'resolve_runtime', return_value={}), \
                 mock.patch.object(ownership_loop, 'store_for'), \
                 mock.patch.object(ownership_loop, 'receive_feedback') as receive:
                code, out, err = self.invoke(body, ['--feedback'])
                self.assertEqual(code, 1)
                self.assertEqual(out, '')
                receive.assert_not_called()
                self.assertEqual(set(json.loads(err)), {'status', 'suppressOrdinaryReply'})
                self.assertTrue(json.loads(err)['suppressOrdinaryReply'])

    def test_registration_cannot_bypass_missing_native_receive(self):
        body = {'projectLabel': 'synthetic-project', 'taskOwner': 'synthetic-owner', 'confirmation': 'EXPLICIT_USER'}
        store = mock.Mock()
        with mock.patch.object(control.auto_wake, 'load_config', return_value={}), \
             mock.patch.object(control.auto_wake, 'resolve_runtime', return_value={}), \
             mock.patch.object(ownership_loop, 'store_for', return_value=store), \
             mock.patch.object(control.receipt_target, 'inbound_claim', side_effect=ValueError('REQUEST_NOT_RECEIVED')):
            code, out, err = self.invoke(json.dumps(body), ['--register-owner'])
        self.assertEqual(code, 1)
        store.register.assert_not_called()
        self.assertIn('REQUEST_NOT_RECEIVED', err)


if __name__ == '__main__':
    unittest.main()
