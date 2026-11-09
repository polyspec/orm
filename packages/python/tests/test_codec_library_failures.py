# codec library failures: an exception of a library that the codec calls never escapes it raw; it is the rule of that call,
# with the exception as its cause (COD-71). ruamel.yaml, which the yaml decode reads the nodes before a collection key
# with, raises an AssertionError, no YAMLError, for a %YAML directive whose minor version is not 1 or 2, which rapidyaml
# reads; the decode refuses it as yaml-parse. The exception types are those of the Python libraries, so this test is
# native (docs/spec/feature-coverage.md FCV-2).
# Requirements: COD-70, COD-71.
import unittest

from polyspec.orm import codec

from . import testcase

# A stream with a %YAML directive that ruamel.yaml refuses by an assertion, and a collection key, so that the decode reads
# it with ruamel.yaml after rapidyaml refuses the key.
DIRECTIVE_STREAMS = [
    "%YAML 1.3\n---\na: .inf\n[b]: c\n",
    "%YAML 1.11\n---\n[b]: c\n",
    "%YAML 1.12\n---\n{[b]: c}\n",
]


class CodecLibraryFailuresTest(unittest.TestCase):
    def test_an_assertion_of_ruamel_yaml_is_the_rule_yaml_parse(self):
        for text in DIRECTIVE_STREAMS:
            with self.subTest(text):
                with self.assertRaises(codec.CodecError) as raised:
                    codec.decode(["yaml"], text)
                self.assertEqual(
                    str(raised.exception),
                    "CODEC_DECODE: yaml: the stream does not parse",
                )
                self.assertIs(type(raised.exception.__cause__), AssertionError)


if __name__ == "__main__":
    testcase.main()
