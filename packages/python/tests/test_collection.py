# Collection lookups by key (docs/interfaces.md "Collection, key, and page"): get, has and fetched read
# the item that put stored under the same key text, and a missing key reads as None.
import sys
import unittest
from pathlib import Path


from polyspec.orm.model import Collection  # noqa: E402


class CollectionLookupTest(unittest.TestCase):
    def test_get_has_and_fetched_read_the_stored_key(self):
        c = Collection()
        c.put(7, 'seven', fetched={'seq': 7})
        c.put('a', 'letter')
        self.assertEqual(c.get(7), 'seven')
        self.assertEqual(c.get('a'), 'letter')
        self.assertIsNone(c.get(8))
        self.assertTrue(c.has(7))
        self.assertFalse(c.has('7'))
        self.assertEqual(c.fetched(7), {'seq': 7})
        self.assertIsNone(c.fetched('a'))
        self.assertIsNone(c.fetched(8))


if __name__ == '__main__':
    unittest.main()
