# The file tests/dbspec/syntax.json itself: its fields, and one case for each analysis input of cases.json
# (test_dbspec_syntax_vectors.vector_inputs), each listed once.
import unittest

from .dbspec_cases_reader import read_cases
from .test_dbspec_syntax_vectors import read_vectors, vector_inputs
from . import testcase


class SyntaxVectorFileTest(unittest.TestCase):
    def test_the_file_holds_a_case_for_every_input(self):
        vectors = read_vectors()
        self.assertEqual(sorted(vectors), ["cases", "note", "requirements", "version"])
        self.assertEqual(vectors["version"], 1)
        expected = {}
        for case in vectors["cases"]:
            self.assertEqual(sorted(case), ["id", "tokens"])
            self.assertNotIn(case["id"], expected, f"{case['id']} is listed twice")
            expected[case["id"]] = case["tokens"]
        self.assertEqual(
            sorted(i for i, _, _ in vector_inputs(read_cases())),
            sorted(expected),
            "the vector ids and the cases of cases.json differ",
        )


if __name__ == "__main__":
    testcase.main()
