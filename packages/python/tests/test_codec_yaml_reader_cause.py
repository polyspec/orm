# codec yaml reader cause: a stream that the grammar of the YAML reader does not hold is yaml-parse, whose cause is the
# error of the reader, which names the line and the column of the place where the stream leaves the grammar, each
# counted from 1, the column in Unicode characters and the byte order mark not counted (COD-71, COD-80). No runtime
# compares its cause with that of another, so no recipe holds the position and this test is native
# (docs/spec/feature-coverage.md FCV-2).
# Requirements: COD-71, COD-80.
import unittest

from polyspec.orm import codec
from polyspec.orm._yaml_reader import YamlReaderError

from . import testcase

# (stream, line, column) of the place where the stream leaves the grammar.
STREAMS = [
    ("a: 1\n\ta: 2\n", 2, 1),
    ("\ufeff[a,,b]\n", 1, 4),
    ("😀😀: [a,,b]\n", 1, 8),
    ('a: 1\r\nb: "\\q"\r\n', 2, 6),
    ("a: 1\rb: [\r", 3, 1),
    ("한글: '값\n", 2, 1),
]


class CodecYamlReaderCauseTest(unittest.TestCase):
    def test_the_cause_of_yaml_parse_names_the_line_and_the_column(self):
        for text, line, column in STREAMS:
            with self.subTest(text):
                with self.assertRaises(codec.CodecError) as raised:
                    codec.decode(["yaml"], text)
                self.assertEqual(
                    str(raised.exception),
                    "CODEC_DECODE: yaml: the stream does not parse",
                )
                cause = raised.exception.__cause__
                self.assertIs(type(cause), YamlReaderError)
                self.assertEqual((cause.line, cause.column), (line, column))
                self.assertTrue(
                    str(cause).startswith(f"line {line}, column {column}: ")
                )


if __name__ == "__main__":
    testcase.main()
