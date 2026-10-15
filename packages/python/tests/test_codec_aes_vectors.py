# The AES vectors of tests/codec/aes-vectors.json: one test for each vector, named by its name
# (codec_vector.check_aes_vector).
# Run: python -m packages.python.tests.test_codec_aes_vectors
import unittest

from .codec_vector import aes_vectors, check_aes_vector
from .vector_case import VectorCase, vector_tests
from . import testcase


class Case(VectorCase):
    """A vector of tests/codec/aes-vectors.json."""


def load_tests(
    loader: unittest.TestLoader, tests: unittest.TestSuite, _pattern: object
) -> unittest.TestSuite:
    """One test for each AES vector, named by its name."""
    tests.addTests(
        vector_tests(
            Case, aes_vectors(), check_aes_vector, lambda vector: vector["name"]
        )
    )
    return tests


if __name__ == "__main__":
    testcase.main()
