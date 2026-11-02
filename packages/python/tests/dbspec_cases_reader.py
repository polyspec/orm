# Reads tests/dbspec/cases.json against its schema (tests/dbspec/schema/cases.schema.json, dbspec_vectors_reader.py):
# every section and every field of the format must be present with its type, and a section or field the format does not
# name is refused. The document cases moved to the recipes (tests/dbspec/*.json); cases.json keeps the hashes and the
# sets. A refusal is a CasesError whose message holds one "<file>: <location> <problem>" line per problem. The client
# tests and the compare runner packages/python/testing/dbspec/compare/python.py read cases.json with it.
import json
from pathlib import Path

from .dbspec_vectors_reader import VectorError, check_vectors

NAME = "tests/dbspec/cases.json"


class CasesError(VectorError):
    """A value of cases.json that the format refuses."""


def check_cases(value, name=NAME):
    """Checks the parsed cases.json value and returns it; name names it in the errors."""
    try:
        check_vectors(value, "cases", name)
    except VectorError as error:
        raise CasesError(str(error)) from None
    return value


def read_cases():
    """Reads tests/dbspec/cases.json of the repository strictly."""
    with open(
        Path(__file__).resolve().parents[3] / "tests" / "dbspec" / "cases.json",
        encoding="utf-8",
    ) as handle:
        return check_cases(json.load(handle))
