"""The full-text predicates (PRT-75): the fulltext_boolean normalization of DIA-6, and the match each dialect renders over
the columns, with SQLite refusing the predicate (DIA-187)."""

import unittest

from polyspec.orm import codes
from polyspec.orm.bind_check import fulltext_boolean, transform_param
from polyspec.orm.engine.dialect import dialect_of
from polyspec.orm.errors import OrmError


class FulltextSearchTest(unittest.TestCase):
    def test_fulltext_search(self):
        cases = {
            "alpha beta": "+alpha +beta*",
            '  +a  (b) "c"  ': "+a +b +c*",
            "one ~ two": "+one +two*",
            "": "",
            "  \t ": "",
            '+ - < > ( ) ~ * " @': "",
        }
        for text, want in cases.items():
            assert fulltext_boolean(text) == want, text

        with self.assertRaises(OrmError) as refused:
            transform_param("fulltext_boolean", "  ")
        self.assertEqual(refused.exception.code, codes.IR_INVALID)

        def value(transform):
            return f"$[{transform}]"

        cols = ["p.name", "p.description"]
        mysql = dialect_of("mysql")()
        postgres = dialect_of("postgres")()
        sqlite = dialect_of("sqlite")()

        assert (
            mysql.fulltext(cols, value, True)
            == "MATCH (p.name, p.description) AGAINST ($[fulltext_boolean] IN BOOLEAN MODE)"
        )
        assert (
            mysql.fulltext(cols, value, False)
            == "MATCH (p.name, p.description) AGAINST ($[] IN NATURAL LANGUAGE MODE)"
        )
        doc = "to_tsvector('simple', coalesce(p.name, '') || ' ' || coalesce(p.description, ''))"
        assert (
            postgres.fulltext(cols, value, False)
            == f"{doc} @@ plainto_tsquery('simple', $[])"
        )
        assert (
            postgres.fulltext(cols, value, True)
            == f"{doc} @@ websearch_to_tsquery('simple', $[])"
        )
        assert sqlite.fulltext(cols, value, True) is None


if __name__ == "__main__":
    unittest.main()
