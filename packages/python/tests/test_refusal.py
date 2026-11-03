# The refusal of the errors vector of tests/conformance/vectors.json before any request (DSL-10, DSL-19, DSL-47,
# DSL-67, DSL-96, DSL-98, DSL-123, PRT-14): each chain runs on a SQLite file that has no table, with a statement
# subscriber, so a chain that reached the database would fail on the missing table with another code and with an event.
import json
import tempfile
import unittest
from pathlib import Path

from . import testcase
from .models import models

ROOT = Path(__file__).resolve().parents[3]

User = models.User
Author = models.Author

CHAINS = [
    ("missing connector", lambda author, db: author().name("a").is_close(True).gets()),
    ("dangling connector", lambda author, db: author().name("a").and_().gets()),
    ("empty list", lambda author, db: author().seq([]).gets()),
    ("no connection", lambda author, db: Author().name("a").gets()),
    ("lock outside a transaction", lambda author, db: author().for_update().gets()),
    (
        "join child with connection",
        lambda author, db: author().join_user_seq_with_seq(User().connect(db)).gets(),
    ),
    ("page with limit", lambda author, db: author().limit(0, 1).gets_page(1, 10)),
    (
        "relation with limit",
        lambda author, db: author()
        .relation(User().match_user_seq_with_seq().limit(0, 1))
        .gets_by_seq(42),
    ),
    ("unjoined model placement", lambda author, db: author().name("a").or_(User()).gets()),
]


class RefusalBeforeRequestTest(unittest.TestCase):
    deadline = testcase.DATABASE

    # Requirements: DSL-10, DSL-19, DSL-47, DSL-67, DSL-96, DSL-98, DSL-123, PRT-14.
    def test_each_chain_of_the_errors_vector_is_refused_before_any_request(self):
        vectors = json.loads((ROOT / "tests/conformance/vectors.sqlite.json").read_text())
        vector = next(v for v in vectors["vectors"] if v["name"] == "errors")
        self.assertEqual(vector["chain"], ", ".join(name for name, _ in CHAINS))
        self.assertEqual(vector["expect"]["statements"], [])
        with tempfile.TemporaryDirectory() as directory:
            db = models.connect(
                f"sqlite://{directory}/refusal.sqlite",
                aesKey="test-aes-key",
                blindIndexKey="test-blind-key",
            )
            try:
                statements = []
                db.subscribe(lambda event: statements.append(event.sql))

                def author():
                    return Author().connect(db)

                # A chain that the spec does not refuse reaches the database,
                # so an empty statement list means no request.
                with self.assertRaises(Exception):
                    author().seq(42).gets()
                self.assertNotEqual(statements, [])

                for (name, chain), expected in zip(CHAINS, vector["expect"]["result"], strict=True):
                    statements.clear()
                    with self.subTest(name), self.assertRaises(Exception) as caught:
                        chain(author, db)
                    self.assertEqual(
                        getattr(caught.exception, "code", None), expected, f"{name}: {caught.exception}"
                    )
                    self.assertEqual(statements, [], f"{name} sent a statement before its refusal")
            finally:
                db.close()


if __name__ == "__main__":
    testcase.main()
