# analyze_dbspec on a text that a JSON recipe line cannot hold, a text without a final line feed (FCV-2). Expected tokens
# are written from the rules of docs/spec/dbspec.md "Syntax analysis", as (line, start, end, class).
import unittest


from polyspec.orm.dbspec import analyze_dbspec
from . import testcase


def tokens_of(text, documents=None):
    return [
        (t.line, t.start, t.end, t.token_class)
        for t in analyze_dbspec(text, documents or {}).tokens
    ]


# The tokens of the header and of the opening of the table of a document.
TABLE_OPENING = [
    (1, 0, 6, "keyword"),
    (1, 7, 8, "number"),
    (1, 9, 12, "name"),
    (3, 0, 5, "keyword"),
    (3, 6, 7, "name"),
    (3, 8, 9, "punctuation"),
]


class AnalyzeTest(unittest.TestCase):
    # Requirements: DBS-144.
    def test_encoding_stop_keeps_earlier_lines_and_lexes_the_rest(self):
        text = "dbspec 1 app\n\ntable t {\n  id i64 bogus!\n}\n\n# x\ry"
        self.assertEqual(
            tokens_of(text),
            [
                *TABLE_OPENING,
                (4, 2, 4, "word"),
                (4, 5, 8, "word"),
                (4, 9, 14, "word"),
                (5, 0, 1, "punctuation"),
                (7, 0, 5, "comment"),
            ],
        )


if __name__ == "__main__":
    testcase.main()
