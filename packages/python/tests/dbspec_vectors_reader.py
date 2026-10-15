# Reads the shared dbspec vector files against their JSON Schemas (tests/dbspec/schema, draft 2020-12) with jsonschema-rs,
# the schemas that the TypeScript runner reads them with (tests/dbspec/vectors.mts). A refused file is reported in the
# form that every compare runner shares (tests/dbspec/compare/runners.test.mts): one "<file>: <location> <problem>" line
# per refusal, where the location is the dotted path of the value (`canonical[0].documents.shop`). A refusal is a
# VectorError whose message holds those lines.
import json
from pathlib import Path

import jsonschema_rs

SCHEMAS = Path(__file__).resolve().parents[3] / "tests" / "dbspec" / "schema"
ARTICLES = {
    "integer": "an integer",
    "object": "an object",
    "array": "an array",
    "string": "a string",
    "boolean": "a boolean",
    "number": "a number",
    "null": "null",
}


class VectorError(ValueError):
    """A vector file that its schema refuses."""


def location(segments):
    """The dotted path of an instance path: object keys joined with ".", array indexes in brackets."""
    path = ""
    for segment in segments:
        if isinstance(segment, int) or str(segment).isdigit():
            path = f"{path}[{segment}]"
        else:
            path = str(segment) if path == "" else f"{path}.{segment}"
    return path


def _leaves(error):
    """The refusals of an error that hold no nested error: the keywords that refused a value."""
    kind = error.kind
    if isinstance(
        kind,
        (
            jsonschema_rs.ValidationErrorKind.AnyOf,
            jsonschema_rs.ValidationErrorKind.OneOfNotValid,
        ),
    ):
        return [
            leaf
            for branch in kind.context
            for nested in branch
            for leaf in _leaves(nested)
        ]
    return [error]


def problems(error):
    """The shared form of one refusal: the location of each value it refuses and what is wrong there."""
    kind, at = error.kind, list(error.instance_path)
    kinds = jsonschema_rs.ValidationErrorKind
    if isinstance(kind, kinds.Required):
        return [f"{location([*at, kind.property])} is missing"]
    if isinstance(kind, (kinds.AdditionalProperties, kinds.UnevaluatedProperties)):
        return [
            f"{location([*at, name])} is not a known field" for name in kind.unexpected
        ]
    if isinstance(kind, kinds.Type):
        return [
            f"{location(at)} is not "
            + " or ".join(ARTICLES.get(t, t) for t in kind.types)
        ]
    if isinstance(kind, kinds.MinItems):
        return [f"{location(at)} is empty"]
    if isinstance(kind, kinds.Constant):
        return [
            f"{location(at)} is not {json.dumps(kind.expected_value, ensure_ascii=False)}"
        ]
    return [f"{location(at)} fails the {kind.name} rule of its schema: {error.message}"]


def refusals(value, kind, name):
    """The refusals of a parsed vector file by the schema tests/dbspec/schema/<kind>.schema.json, each
    "<name>: <location> <problem>"; none when the schema accepts it."""
    with open(SCHEMAS / f"{kind}.schema.json", encoding="utf-8") as handle:
        validator = jsonschema_rs.validator_for(json.load(handle))
    lines = []
    for error in validator.iter_errors(value):
        for leaf in _leaves(error):
            for problem in problems(leaf):
                line = f"{name}: {problem}"
                if line not in lines:
                    lines.append(line)
    return lines


def check_vectors(value, kind, name):
    """Checks a parsed vector file against the schema kind and returns it; a refusal raises a VectorError."""
    lines = refusals(value, kind, name)
    if lines:
        raise VectorError("\n".join(lines))
    return value
