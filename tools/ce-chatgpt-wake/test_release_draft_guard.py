"""Shared observer rejects unreadable drafts before any input can occur."""
import copy
import unittest

import wake
from test_wake import snapshot


class DraftBoundaryTests(unittest.TestCase):
    def test_unreadable_draft_never_becomes_empty(self):
        for value in (None, False, 0, [], {}):
            envelope = snapshot()
            envelope['data']['tree']['children'][0]['children'][1]['value'] = value
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, '^DRAFT_STATE_UNKNOWN$'):
                wake.observe(envelope, {'windowId': 'w-1'}, require_marker=False)
        envelope = snapshot()
        del envelope['data']['tree']['children'][0]['children'][1]['value']
        with self.assertRaisesRegex(ValueError, '^DRAFT_STATE_UNKNOWN$'):
            wake.observe(envelope, {'windowId': 'w-1'}, require_marker=False)

    def test_strings_are_preserved_without_whitespace_normalization(self):
        for text in ('', ' ', '\n', 'hello  world\n', '你好'):
            with self.subTest(text=text):
                view = wake.observe(snapshot(text), {'windowId': 'w-1'}, require_marker=False)
                self.assertEqual(view['draft'], text)

    def test_counts_describe_actual_controls_even_when_composer_missing(self):
        for kind, expected in [('composer-missing', {'composer': 0, 'send': 1}),
                               ('send-missing', {'composer': 1, 'send': 0}),
                               ('duplicate-input', {'composer': 2, 'send': 1}),
                               ('duplicate-send', {'composer': 1, 'send': 2}),
                               ('draft-null', {'composer': 1, 'send': 1})]:
            envelope = snapshot()
            children = envelope['data']['tree']['children'][0]['children']
            if kind == 'composer-missing':
                children.pop(1)
            elif kind == 'send-missing':
                children.pop(2)
            elif kind == 'duplicate-input':
                children.append(copy.deepcopy(children[1]))
            elif kind == 'duplicate-send':
                children.append(copy.deepcopy(children[2]))
            else:
                children[1]['value'] = None
            with self.subTest(kind=kind):
                with self.assertRaises(ValueError):
                    wake.observe(envelope, {'windowId': 'w-1'}, require_marker=False)
                counts = wake.selector_counts(envelope)
                self.assertEqual(counts, expected)
                self.assertNotIn('draft', counts)


if __name__ == '__main__':
    unittest.main()
