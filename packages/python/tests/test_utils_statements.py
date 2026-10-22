# The PostgreSQL statements of the utility functions are written with $n markers, the form the engine writes for
# PostgreSQL. A ? marker there reaches the driver unbound (ValueError from for_postgres), as it did before.
import unittest


from polyspec.orm.placeholders import for_postgres
from polyspec.orm.utils import POSTGRES_ADVISORY_LOCK, POSTGRES_SET_LOCAL
from . import testcase


class PostgresUtilityStatements(unittest.TestCase):
    # Requirements: DIA-2.
    def test_advisory_lock_statement_uses_numbered_markers(self):
        text, args = for_postgres(POSTGRES_ADVISORY_LOCK, ["key"])
        self.assertEqual(
            text, "SELECT pg_advisory_xact_lock(hashtextextended(%(p1)s, 0))"
        )
        self.assertEqual(args, {"p1": "key"})

    def test_set_local_statement_uses_numbered_markers(self):
        text, args = for_postgres(POSTGRES_SET_LOCAL, ["k", "v"])
        self.assertEqual(text, "SELECT set_config(%(p1)s, %(p2)s, true)")
        self.assertEqual(args, {"p1": "k", "p2": "v"})


if __name__ == "__main__":
    testcase.main()
