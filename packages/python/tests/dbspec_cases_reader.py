# Reads tests/dbspec/cases.json against its schema (tests/dbspec/schema/cases.schema.json, dbspec_vectors_reader.py):
# every section and every field of the format must be present with its type, a section or field the format does not
# name is refused, and every section has a case. The schema cannot state that the main document of a case is one of its
# documents; check_cases checks it. A refusal is a CasesError whose message holds one "<file>: <location> <problem>" line
# per problem. The client tests and the compare runner tests/dbspec/compare/python.py read cases.json with it.
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
    for section in ("canonical", "normalize", "invalid", "positions"):
        for i, case in enumerate(value[section]):
            if case["main"] not in case["documents"]:
                raise CasesError(
                    f"{name}: {section}[{i}].documents.{case['main']} is missing"
                )
    return value


def read_cases():
    """Reads tests/dbspec/cases.json of the repository strictly."""
    with open(
        Path(__file__).resolve().parents[3] / "tests" / "dbspec" / "cases.json",
        encoding="utf-8",
    ) as handle:
        return check_cases(json.load(handle))
