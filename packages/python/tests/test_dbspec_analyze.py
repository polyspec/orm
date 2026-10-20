# analyze_dbspec and format_dbspec: the token classes of docs/spec/dbspec.md "Syntax analysis" and the
# formatting rules of "Formatting". Expected tokens are written from the rules, as (line, start, end, class).
import unittest


from polyspec.orm.dbspec import analyze_dbspec, format_dbspec, parse_dbspec
from . import testcase


def tokens_of(text, documents=None):
    return [
        (t.line, t.start, t.end, t.token_class)
        for t in analyze_dbspec(text, documents or {}).tokens
    ]


TABLE = "dbspec 1 app\n\ntable t {\n  id i64\n  primary key (id)\n}\n"


class AnalyzeTest(unittest.TestCase):
    # Requirements: DBS-134, DBS-135.
    def test_header_only(self):
        self.assertEqual(
            tokens_of("dbspec 1 app\n"),
            [(1, 0, 6, "keyword"), (1, 7, 8, "number"), (1, 9, 12, "name")],
        )

    def test_table_document(self):
        self.assertEqual(
            tokens_of(TABLE),
            [
                (1, 0, 6, "keyword"),
                (1, 7, 8, "number"),
                (1, 9, 12, "name"),
                (3, 0, 5, "keyword"),
                (3, 6, 7, "name"),
                (3, 8, 9, "punctuation"),
                (4, 2, 4, "name"),
                (4, 5, 8, "type"),
                (5, 2, 9, "keyword"),
                (5, 10, 13, "keyword"),
                (5, 14, 15, "punctuation"),
                (5, 15, 17, "name"),
                (5, 17, 18, "punctuation"),
                (6, 0, 1, "punctuation"),
            ],
        )

    def test_comment_line_is_one_token(self):
        self.assertEqual(tokens_of("dbspec 1 app\n# note\n")[-1], (2, 0, 6, "comment"))

    def test_name_position_takes_number_text(self):
        result = tokens_of(
            "dbspec 1 app\n\ntable 12 {\n  id i64\n  primary key (id)\n}\n"
        )
        self.assertIn((3, 6, 8, "name"), result)

    def test_abandoned_line_words_are_word(self):
        result = tokens_of("dbspec 1 app\n\ntable t {\n  id i64 primary key\n}\n")
        self.assertEqual(
            [t for t in result if t[0] == 4],
            [
                (4, 2, 4, "word"),
                (4, 5, 8, "word"),
                (4, 9, 16, "word"),
                (4, 17, 20, "word"),
            ],
        )

    def test_unclosed_block_keeps_classes(self):
        result = tokens_of("dbspec 1 app\n\ntable t {\n  id i64\n  primary key (id)\n")
        self.assertIn((3, 0, 5, "keyword"), result)
        self.assertIn((3, 6, 7, "name"), result)

    def test_header_failure_is_lexical(self):
        self.assertEqual(
            tokens_of("dbspec 1 app x\n"),
            [
                (1, 0, 6, "word"),
                (1, 7, 8, "number"),
                (1, 9, 12, "word"),
                (1, 13, 14, "word"),
            ],
        )

    def test_comment_before_header_is_lexical(self):
        self.assertEqual(
            tokens_of("# c\ndbspec 1 app\n"),
            [
                (1, 0, 3, "comment"),
                (2, 0, 6, "word"),
                (2, 7, 8, "number"),
                (2, 9, 12, "word"),
            ],
        )

    def test_encoding_stop_keeps_earlier_lines_and_lexes_the_rest(self):
        text = "dbspec 1 app\n\ntable t {\n  id i64 bogus!\n}\n\n# x\ry"
        self.assertEqual(
            tokens_of(text),
            [
                (1, 0, 6, "keyword"),
                (1, 7, 8, "number"),
                (1, 9, 12, "name"),
                (3, 0, 5, "keyword"),
                (3, 6, 7, "name"),
                (3, 8, 9, "punctuation"),
                (4, 2, 4, "word"),
                (4, 5, 8, "word"),
                (4, 9, 14, "word"),
                (5, 0, 1, "punctuation"),
                (7, 0, 5, "comment"),
            ],
        )

    def test_limit_stop_gives_no_tokens(self):
        columns = "".join(f"  c{i} i64\n" for i in range(1001))
        result = analyze_dbspec(f"dbspec 1 app\n\ntable t {{\n{columns}}}\n", {})
        self.assertEqual(result.tokens, ())
        self.assertEqual([d.rule for d in result.diagnostics], ["limit"])

    def test_minus_before_number_is_operator(self):
        result = tokens_of(
            "dbspec 1 app\n\ntable t {\n  id i64 default -1\n  primary key (id)\n}\n"
        )
        self.assertEqual(
            [t for t in result if t[0] == 4],
            [
                (4, 2, 4, "name"),
                (4, 5, 8, "type"),
                (4, 9, 16, "keyword"),
                (4, 17, 18, "operator"),
                (4, 18, 19, "number"),
            ],
        )

    def test_value_keywords(self):
        result = tokens_of(
            "dbspec 1 app\n\ntable t {\n  ok bool default true\n  primary key (ok)\n}\n"
        )
        self.assertEqual(
            [t for t in result if t[0] == 4],
            [
                (4, 2, 4, "name"),
                (4, 5, 9, "type"),
                (4, 10, 17, "keyword"),
                (4, 18, 22, "keyword"),
            ],
        )

    def test_tab_offending_and_line_abandoned(self):
        result = tokens_of(
            "dbspec 1 app\n\ntable t {\n\tid i64\n  primary key (id)\n}\n"
        )
        self.assertEqual(
            [t for t in result if t[0] == 4], [(4, 1, 3, "word"), (4, 4, 7, "word")]
        )

    def test_analysis_keeps_the_parse_result(self):
        analysis = analyze_dbspec(TABLE, {})
        document, positions, diagnostics = parse_dbspec(TABLE, {})
        self.assertEqual(analysis.document, document)
        self.assertEqual(analysis.positions, positions)
        self.assertEqual(analysis.diagnostics, list(diagnostics))


class FormatTest(unittest.TestCase):
    def test_invalid_document_is_refused(self):
        text = "dbspec 1 app\n\ntable t {\n  id i64 bogus\n  primary key (id)\n}\n"
        text_out, diagnostics = format_dbspec(text, {})
        self.assertIsNone(text_out)
        self.assertEqual([(d.rule, d.line) for d in diagnostics], [("syntax", 4)])

    def test_format_is_idempotent(self):
        text = "dbspec 1 app\n\n\ntable t {\n  id i64\n  primary key (id)\n}\n"
        once, diagnostics = format_dbspec(text, {})
        self.assertEqual(diagnostics, [])
        twice, _ = format_dbspec(once, {})
        self.assertEqual(twice, once)


if __name__ == "__main__":
    testcase.main()
