# 공유 dbspec 사례 검사: tests/dbspec/cases.json의 canonical, normalize, invalid,
# hashes, sets, files 사례를 전부 실행한다 (다른 client의 dbspec test와 같은 검사).
# 실행: python clients/python/tests/dbspec_cases.py
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from polyspec.orm.dbspec import (check_set, dbspec_manifest, emit_dbspec, parse_dbspec,
                                 read_dbspec_file)

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


class DbspecCaseTest(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        with open(ROOT / 'tests' / 'dbspec' / 'cases.json', encoding='utf-8') as handle:
            cls.cases = json.load(handle)

    def test_canonical(self):
        failures = []
        for case in self.cases['canonical']:
            documents = {name: text_of(case, lines)
                         for name, lines in case['documents'].items()}
            document, diagnostics = parse_dbspec(documents[case['main']],
                                                 {k: v for k, v in documents.items()
                                                  if k != case['main']})
            if document is None:
                failures.append(f"{case['id']}: parse {error_lines(diagnostics)}")
                continue
            emitted = emit_dbspec(document)
            expected = text_of(case, case['canonical'], as_input=False) \
                if 'canonical' in case else documents[case['main']]
            if emitted != expected:
                failures.append(f"{case['id']}: emit differs\n--- want\n{expected}\n"
                                f"--- got\n{emitted}")
        if failures:
            self.fail('\n'.join(failures))

    def test_normalize(self):
        failures = []
        for case in self.cases['normalize']:
            documents = {name: text_of(case, lines)
                         for name, lines in case['documents'].items()}
            document, diagnostics = parse_dbspec(documents[case['main']],
                                                 {k: v for k, v in documents.items()
                                                  if k != case['main']})
            if document is None:
                failures.append(f"{case['id']}: parse {error_lines(diagnostics)}")
                continue
            emitted = emit_dbspec(document)
            expected = text_of(case, case['canonical'], as_input=False)
            if emitted != expected:
                failures.append(f"{case['id']}: emit differs\n--- want\n{expected}\n"
                                f"--- got\n{emitted}")
        if failures:
            self.fail('\n'.join(failures))

    def test_invalid(self):
        failures = []
        for case in self.cases['invalid']:
            documents = {name: text_of(case, lines)
                         for name, lines in case['documents'].items()}
            document, diagnostics = parse_dbspec(documents[case['main']],
                                                 {k: v for k, v in documents.items()
                                                  if k != case['main']})
            if document is not None:
                failures.append(f"{case['id']}: parsed an invalid document")
                continue
            found = [(d.line, d.column, d.rule) for d in diagnostics]
            expected = [(e['line'], e['column'], e['rule']) for e in case['errors']]
            if found != expected:
                failures.append(f"{case['id']}: want {expected} got {found} "
                                f"({error_lines(diagnostics)})")
        if failures:
            self.fail('\n'.join(failures))

    def test_hashes(self):
        failures = []
        for case in self.cases['hashes']:
            documents = {name: text_of(case, lines)
                         for name, lines in case['documents'].items()}
            parsed = []
            for name, text in documents.items():
                others = {k: v for k, v in documents.items() if k != name}
                document, diagnostics = parse_dbspec(text, others)
                if document is None:
                    failures.append(f"{case['id']}/{name}: parse {error_lines(diagnostics)}")
                    parsed = None
                    break
                parsed.append(document)
            if parsed is None:
                continue
            manifest, diagnostics = dbspec_manifest(parsed)
            if manifest is None:
                failures.append(f"{case['id']}: manifest {error_lines(diagnostics)}")
                continue
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
        if failures:
            self.fail('\n'.join(failures))

    def test_sets(self):
        failures = []
        import dataclasses
        for case in self.cases['sets']:
            owned = len(case['documents'])
            every = list(case['documents']) + list(case.get('external', []))
            parsing = {name: '\n'.join(lines) + '\n'
                       for name, lines in case.get('parsing', {}).items()}

            def name_of(lines) -> str:
                return lines[0].split(' ')[2]

            parsed = []
            broken = False
            for index, lines in enumerate(every):
                set_texts = dict(parsing)
                for other_index, other in enumerate(every):
                    if other_index != index:
                        set_texts[name_of(other)] = '\n'.join(other) + '\n'
                document, diagnostics = parse_dbspec('\n'.join(lines) + '\n', set_texts)
                if document is None:
                    failures.append(f"{case['id']}/{name_of(lines)}: parse "
                                    f"{error_lines(diagnostics)}")
                    broken = True
                    break
                if index >= owned:
                    document = dataclasses.replace(document, external=True)
                parsed.append(document)
            if broken:
                continue
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
        if failures:
            self.fail('\n'.join(failures))

    def test_files(self):
        failures = []
        for case in self.cases['files']:
            text, diagnostics = read_dbspec_file(str(ROOT / 'tests' / 'dbspec' / case['path']))
            found = [(d.line, d.column, d.rule) for d in diagnostics]
            expected = [(e['line'], e['column'], e['rule']) for e in case['errors']]
            if found != expected:
                failures.append(f"{case['id']}: want {expected} got {found}")
        if failures:
            self.fail('\n'.join(failures))


if __name__ == '__main__':
    unittest.main()
