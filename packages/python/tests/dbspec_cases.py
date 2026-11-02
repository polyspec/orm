# The checks of the shared dbspec cases that remain in tests/dbspec/cases.json (the same checks as the dbspec tests of the
# other clients): the manifest hashes and the document sets. Each section runs from its own module, test_dbspec_<section>.py,
# one test for each case of that section, named by the case id. The document cases (canonical, normalize, invalid,
# positions, files and set-parse) run from their recipes (recipe_<section>.py), and the unit tests of the parse positions
# are here too.
# Run: python -m packages.python.tests.dbspec_cases
import dataclasses
import unittest


from polyspec.orm.dbspec import (
    DbspecPosition,
    dbspec_manifest,
    parse_dbspec,
)
from polyspec.orm.engine.model import RuntimeModel
from polyspec.orm.errors import OrmError
from . import testcase


def text_of(case, lines, as_input: bool = True) -> str:
    """Joins the case lines: LF, or CRLF when (input) crlf, or when (input) mixed
    alternating CRLF and LF, with no line ending on the last line. The canonical expected value is always LF."""
    if as_input and case.get("mixed"):
        return (
            "".join(
                line + ("\r\n" if index % 2 == 0 else "\n")
                for index, line in enumerate(lines[:-1])
            )
            + lines[-1]
        )
    end = "\r\n" if as_input and case.get("crlf") else "\n"
    return end.join(lines) + end


def error_lines(diagnostics) -> str:
    return "; ".join(f"{d.rule} {d.line}:{d.column} {d.message}" for d in diagnostics)


def documents_of(case) -> dict:
    return {name: text_of(case, lines) for name, lines in case["documents"].items()}


def check_failures(test: unittest.TestCase, failures: list) -> None:
    if failures:
        test.fail("\n".join(failures))


def check_hashes(test: unittest.TestCase, case) -> None:
    documents = documents_of(case)
    parsed = []
    for name, text in documents.items():
        others = {k: v for k, v in documents.items() if k != name}
        document, _positions, diagnostics = parse_dbspec(text, others)
        if document is None:
            test.fail(f"{case['id']}/{name}: parse {error_lines(diagnostics)}")
        parsed.append(document)
    manifest, diagnostics = dbspec_manifest(parsed)
    if manifest is None:
        test.fail(f"{case['id']}: manifest {error_lines(diagnostics)}")
    failures = []
    for field, lines in (
        ("manifest_text", "manifestText"),
        ("schema_text", "schemaText"),
    ):
        expected = text_of(case, case[lines])
        found = getattr(manifest, field)
        if found != expected:
            failures.append(
                f"{case['id']}: {field} differs\n--- want\n{expected}\n--- got\n{found}"
            )
    for field, key in (
        ("manifest_hash", "manifestHash"),
        ("schema_hash", "schemaHash"),
    ):
        if getattr(manifest, field) != case[key]:
            failures.append(
                f"{case['id']}: {field} {getattr(manifest, field)} want {case[key]}"
            )
    check_failures(test, failures)


def check_sets(test: unittest.TestCase, case) -> None:
    owned = len(case["documents"])
    every = list(case["documents"]) + list(case.get("external", []))
    parsing = {
        name: "\n".join(lines) + "\n" for name, lines in case.get("parsing", {}).items()
    }

    def name_of(lines) -> str:
        return lines[0].split(" ")[2]

    parsed = []
    for index, lines in enumerate(every):
        set_texts = dict(parsing)
        for other_index, other in enumerate(every):
            if other_index != index:
                set_texts[name_of(other)] = "\n".join(other) + "\n"
        document, _positions, diagnostics = parse_dbspec(
            "\n".join(lines) + "\n", set_texts
        )
        if document is None:
            test.fail(
                f"{case['id']}/{name_of(lines)}: parse {error_lines(diagnostics)}"
            )
        if index >= owned:
            document = dataclasses.replace(document, external=True)
        parsed.append(document)
    failures = []
    manifest, diagnostics = dbspec_manifest(parsed)
    found = [(d.line, d.column, d.rule) for d in diagnostics]
    expected = [(e["line"], e["column"], e["rule"]) for e in case["errors"]]
    if found != expected:
        failures.append(f"{case['id']}: manifest want {expected} got {found}")
    if manifest is None and not expected:
        failures.append(f"{case['id']}: manifest is None without errors")
    if manifest is not None and case.get("manifest") is not None:
        want = case["manifest"]
        # The runtime model is built from the manifest text and the external text, so they parse back as a set
        # without diagnostics (docs/spec/dbspec.md "Manifest and hashes").
        try:
            RuntimeModel.load_set(manifest.manifest_text, manifest.external_text)
        except OrmError as error:
            failures.append(
                f"{case['id']}: runtime model of the manifest and external text: {error}"
            )
        for field, value in (
            (
                "manifest_text",
                "\n".join(want["manifestText"]) + "\n" if want["manifestText"] else "",
            ),
            (
                "external_text",
                "\n".join(want["externalText"]) + "\n" if want["externalText"] else "",
            ),
            (
                "schema_text",
                "\n".join(want["schemaText"]) + "\n" if want["schemaText"] else "",
            ),
            ("manifest_hash", want["manifestHash"]),
            ("schema_hash", want["schemaHash"]),
        ):
            if getattr(manifest, field) != value:
                failures.append(
                    f"{case['id']}: {field} differs\n--- want\n"
                    f"{value}\n--- got\n{getattr(manifest, field)}"
                )
    check_failures(test, failures)


class DbspecPositionTest(unittest.TestCase):
    # Requirements: ORES-83.
    def test_position_is_frozen_with_tuple_path(self):
        position = DbspecPosition("table", ("orders",), 5, 7)
        self.assertEqual(
            (position.kind, position.path, position.line, position.column),
            ("table", ("orders",), 5, 7),
        )
        with self.assertRaises(dataclasses.FrozenInstanceError):
            position.line = 6

    def test_failed_parse_returns_no_positions(self):
        for text in (
            "dbspec 1 bad\n\ntable orders {\n",
            "dbspec 1 bad\n\ntable orders {\n  id i64\n}\n  x\n",
        ):
            with self.subTest(text=text):
                document, positions, diagnostics = parse_dbspec(text, {})
                self.assertIsNone(document)
                self.assertIsNone(positions)
                self.assertTrue(diagnostics)

    def test_successful_parse_returns_positions_in_source_order(self):
        document, positions, diagnostics = parse_dbspec(
            "dbspec 1 shop\n\ntable orders {\n  id i64 identity\n  primary key (id)\n}\n",
            {},
        )
        self.assertIsNotNone(document)
        self.assertEqual(list(diagnostics), [])
        self.assertEqual(
            [(p.kind, p.path, p.line, p.column) for p in positions],
            [
                ("document", ("shop",), 1, 10),
                ("table", ("orders",), 3, 7),
                ("column", ("orders", "id"), 4, 3),
                ("constraint", ("orders", "primary key"), 5, 3),
            ],
        )


if __name__ == "__main__":
    testcase.main()
