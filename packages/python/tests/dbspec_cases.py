# 공유 dbspec 사례 검사: tests/dbspec/cases.json의 canonical, normalize, invalid,
# hashes, sets, files 사례를 전부 실행한다 (다른 client의 dbspec test와 같은 검사).
# 실행: python packages/python/tests/dbspec_cases.py
import dataclasses
import sys
import unittest
from pathlib import Path


from polyspec.orm.dbspec import (DbspecPosition, check_set, dbspec_manifest, emit_dbspec,
                                 format_dbspec, parse_dbspec, read_dbspec_file)
from dbspec_cases_reader import read_cases  # noqa: E402
from vector_case import VectorCase, vector_tests  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]


def text_of(case, lines, as_input: bool = True) -> str:
    """사례의 줄을 잇는다: LF, 또는 (입력이고) crlf면 CRLF, (입력이고) mixed면
    CRLF와 LF를 번갈아 마지막 줄은 줄 끝 없이. canonical 기대값은 항상 LF다."""
    if as_input and case.get('mixed'):
        return ''.join(line + ('\r\n' if index % 2 == 0 else '\n')
                       for index, line in enumerate(lines[:-1])) + lines[-1]
    end = '\r\n' if as_input and case.get('crlf') else '\n'
    return end.join(lines) + end


def error_lines(diagnostics) -> str:
    return '; '.join(f'{d.rule} {d.line}:{d.column} {d.message}' for d in diagnostics)


def documents_of(case) -> dict:
    return {name: text_of(case, lines) for name, lines in case['documents'].items()}


def others_of(case, documents: dict) -> dict:
    return {k: v for k, v in documents.items() if k != case['main']}


def check_failures(test: unittest.TestCase, failures: list) -> None:
    if failures:
        test.fail('\n'.join(failures))


def format_failures(case, expected: str) -> list:
    """format is emit(parse): the case formats to its canonical text, and formatting twice changes nothing."""
    documents = documents_of(case)
    others = others_of(case, documents)
    formatted, diagnostics = format_dbspec(documents[case['main']], others)
    if formatted is None:
        return [f"{case['id']}: refused {error_lines(diagnostics)}"]
    failures = []
    if formatted != expected:
        failures.append(f"{case['id']}: format differs\n--- want\n{expected}\n"
                        f"--- got\n{formatted}")
    again, _ = format_dbspec(formatted, others)
    if again != formatted:
        failures.append(f"{case['id']}: format is not idempotent")
    return failures


def emit_failures(case, expected: str) -> list:
    documents = documents_of(case)
    document, _positions, diagnostics = parse_dbspec(documents[case['main']], others_of(case, documents))
    if document is None:
        return [f"{case['id']}: parse {error_lines(diagnostics)}"]
    emitted = emit_dbspec(document)
    if emitted != expected:
        return [f"{case['id']}: emit differs\n--- want\n{expected}\n"
                f"--- got\n{emitted}"]
    return []


def check_canonical(test: unittest.TestCase, case) -> None:
    expected = documents_of(case)[case['main']]
    check_failures(test, emit_failures(case, expected) + format_failures(case, expected))


def check_normalize(test: unittest.TestCase, case) -> None:
    expected = text_of(case, case['canonical'], as_input=False)
    check_failures(test, emit_failures(case, expected) + format_failures(case, expected))


def check_invalid(test: unittest.TestCase, case) -> None:
    failures = []
    documents = documents_of(case)
    others = others_of(case, documents)
    expected = [(e['line'], e['column'], e['rule']) for e in case['errors']]
    document, _positions, diagnostics = parse_dbspec(documents[case['main']], others)
    if document is not None:
        failures.append(f"{case['id']}: parsed an invalid document")
    else:
        found = [(d.line, d.column, d.rule) for d in diagnostics]
        if found != expected:
            failures.append(f"{case['id']}: want {expected} got {found} "
                            f"({error_lines(diagnostics)})")
    # format refuses an invalid case with its diagnostics.
    formatted, diagnostics = format_dbspec(documents[case['main']], others)
    found = [(d.line, d.column, d.rule) for d in diagnostics]
    if formatted is not None or found != expected:
        failures.append(f"{case['id']}: want refusal {expected} got {formatted!r} {found}")
    check_failures(test, failures)


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
    for field, lines in (('manifest_text', 'manifestText'),
                         ('schema_text', 'schemaText')):
        expected = text_of(case, case[lines])
        found = getattr(manifest, field)
        if found != expected:
            failures.append(f"{case['id']}: {field} differs\n--- want\n{expected}\n"
                            f"--- got\n{found}")
    for field, key in (('manifest_hash', 'manifestHash'), ('schema_hash', 'schemaHash')):
        if getattr(manifest, field) != case[key]:
            failures.append(f"{case['id']}: {field} "
                            f"{getattr(manifest, field)} want {case[key]}")
    check_failures(test, failures)


def check_sets(test: unittest.TestCase, case) -> None:
    owned = len(case['documents'])
    every = list(case['documents']) + list(case.get('external', []))
    parsing = {name: '\n'.join(lines) + '\n'
               for name, lines in case.get('parsing', {}).items()}

    def name_of(lines) -> str:
        return lines[0].split(' ')[2]

    parsed = []
    for index, lines in enumerate(every):
        set_texts = dict(parsing)
        for other_index, other in enumerate(every):
            if other_index != index:
                set_texts[name_of(other)] = '\n'.join(other) + '\n'
        document, _positions, diagnostics = parse_dbspec('\n'.join(lines) + '\n', set_texts)
        if document is None:
            test.fail(f"{case['id']}/{name_of(lines)}: parse {error_lines(diagnostics)}")
        if index >= owned:
            document = dataclasses.replace(document, external=True)
        parsed.append(document)
    failures = []
    manifest, diagnostics = dbspec_manifest(parsed)
    found = [(d.line, d.column, d.rule) for d in diagnostics]
    expected = [(e['line'], e['column'], e['rule']) for e in case['errors']]
    if found != expected:
        failures.append(f"{case['id']}: manifest want {expected} got {found}")
    if manifest is None and not expected:
        failures.append(f"{case['id']}: manifest is None without errors")
    if manifest is not None and case.get('manifest') is not None:
        want = case['manifest']
        for field, value in (('manifest_text', '\n'.join(want['manifestText']) + '\n'
                              if want['manifestText'] else ''),
                             ('external_text', '\n'.join(want['externalText']) + '\n'
                              if want['externalText'] else ''),
                             ('schema_text', '\n'.join(want['schemaText']) + '\n'
                              if want['schemaText'] else ''),
                             ('manifest_hash', want['manifestHash']),
                             ('schema_hash', want['schemaHash'])):
            if getattr(manifest, field) != value:
                failures.append(f"{case['id']}: {field} differs\n--- want\n"
                                f"{value}\n--- got\n{getattr(manifest, field)}")
    check_failures(test, failures)


def check_positions(test: unittest.TestCase, case) -> None:
    want = [(p['kind'], tuple(p['path']), p['line'], p['column']) for p in case['positions']]
    documents = documents_of(case)
    document, positions, diagnostics = parse_dbspec(documents[case['main']], others_of(case, documents))
    if document is None:
        test.fail(f"{case['id']}: parse {error_lines(diagnostics)}")
    found = [(p.kind, p.path, p.line, p.column) for p in positions]
    if found != want:
        test.fail(f"{case['id']}: positions want\n{want}\n--- got\n{found}")


def check_files(test: unittest.TestCase, case) -> None:
    text, diagnostics = read_dbspec_file(str(ROOT / 'tests' / 'dbspec' / case['path']))
    found = [(d.line, d.column, d.rule) for d in diagnostics]
    expected = [(e['line'], e['column'], e['rule']) for e in case['errors']]
    if found != expected:
        test.fail(f"{case['id']}: want {expected} got {found}")


# Each section's check, in the order of cases.json.
CHECKS = (('canonical', check_canonical), ('normalize', check_normalize), ('invalid', check_invalid),
          ('hashes', check_hashes), ('sets', check_sets), ('files', check_files), ('positions', check_positions))


class Case(VectorCase):
    """A case of the vector file of this module."""


def load_tests(loader: unittest.TestLoader, tests: unittest.TestSuite, pattern: object) -> unittest.TestSuite:
    """One test for each case of every section, named by the case id."""
    cases = read_cases()
    for section, check in CHECKS:
        tests.addTests(vector_tests(Case, cases[section], check))
    return tests


class DbspecPositionTest(unittest.TestCase):
    def test_position_is_frozen_with_tuple_path(self):
        position = DbspecPosition('table', ('orders',), 5, 7)
        self.assertEqual((position.kind, position.path, position.line, position.column),
                         ('table', ('orders',), 5, 7))
        with self.assertRaises(dataclasses.FrozenInstanceError):
            position.line = 6

    def test_failed_parse_returns_no_positions(self):
        for text in ('dbspec 1 bad\n\ntable orders {\n',
                     'dbspec 1 bad\n\ntable orders {\n  id i64\n}\n  x\n'):
            with self.subTest(text=text):
                document, positions, diagnostics = parse_dbspec(text, {})
                self.assertIsNone(document)
                self.assertIsNone(positions)
                self.assertTrue(diagnostics)

    def test_successful_parse_returns_positions_in_source_order(self):
        document, positions, diagnostics = parse_dbspec(
            'dbspec 1 shop\n\ntable orders {\n  id i64 identity\n  primary key (id)\n}\n', {})
        self.assertIsNotNone(document)
        self.assertEqual(list(diagnostics), [])
        self.assertEqual([(p.kind, p.path, p.line, p.column) for p in positions], [
            ('document', ('shop',), 1, 10),
            ('table', ('orders',), 3, 7),
            ('column', ('orders', 'id'), 4, 3),
            ('constraint', ('orders', 'primary key'), 5, 3),
        ])


if __name__ == '__main__':
    unittest.main()
