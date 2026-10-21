# The codec vectors of tests/codec/vectors.json: one test for each vector, named by the vector (codec_vector.check_vector).
# When ORM_CODEC_OUT (make codec-check) is set, tearDownModule writes the encoded output of every vector to python.json in
# that directory, which the PHP CodecVectorsTest decodes for the comparison.
# Run: make codec-check/python
import json
import os
import unittest

from .codec_vector import OUTPUT, check_vector, codec_vectors
from .vector_case import VectorCase, vector_tests
from . import testcase


def tearDownModule() -> None:
    """Writes the encoded output of every codec vector only to the directory that ORM_CODEC_OUT (make codec-check)
    names, through a temporary file renamed into place."""
    directory = os.environ.get("ORM_CODEC_OUT")
    if directory:
        os.makedirs(directory, exist_ok=True)
        temporary = os.path.join(directory, f"python.json.tmp-{os.getpid()}")
        with open(temporary, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(OUTPUT, indent=2) + "\n")
        os.replace(temporary, os.path.join(directory, "python.json"))


class Case(VectorCase):
    """A vector of tests/codec/vectors.json."""


def load_tests(
    loader: unittest.TestLoader, tests: unittest.TestSuite, _pattern: object
) -> unittest.TestSuite:
    """One test for each codec vector, named by the vector."""
    tests.addTests(
        vector_tests(Case, codec_vectors(), check_vector, lambda vector: vector["name"])
    )
    return tests


if __name__ == "__main__":
    testcase.main()
