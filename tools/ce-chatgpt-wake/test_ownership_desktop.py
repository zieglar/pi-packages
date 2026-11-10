import unittest
from unittest import mock

import ownership_loop as loop
import wake
from test_wake import snapshot


class DesktopBoundaryTests(unittest.TestCase):
    def cli(self, draft=''):
        cli = object.__new__(loop.CurrentDesktop)
        cli.config = {'windowId': 'w-1', 'checkAuthority': mock.Mock(side_effect=ValueError('OPERATOR_DISABLED'))}
        cli.snapshot = lambda: snapshot(draft)
        return cli

    def test_fill_rechecks_operator_after_fresh_ui_and_before_mutation(self):
        cli = self.cli()
        with mock.patch.object(wake.ChatGptCli, 'fill') as fill:
            with self.assertRaisesRegex(ValueError, 'OPERATOR_DISABLED'):
                cli.fill('@old', 'synthetic fixed prompt')
        fill.assert_not_called()

    def test_submit_rechecks_operator_after_readback_and_before_click(self):
        cli = self.cli('synthetic fixed prompt')
        cli.expected_prompt = 'synthetic fixed prompt'
        with mock.patch.object(wake.ChatGptCli, 'submit') as submit:
            with self.assertRaisesRegex(ValueError, 'OPERATOR_DISABLED'):
                cli.submit('@old')
        submit.assert_not_called()


if __name__ == '__main__':
    unittest.main()
