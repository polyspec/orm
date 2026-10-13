# The shared token vectors of tests/dbspec/syntax.json: every runtime matches them exactly. The inputs are
# built as scripts/dbspec/syntax-vectors.mjs vectorInputs builds them, and every case must be present.
import json
import sys
import unittest
from pathlib import Path


from polyspec.orm.dbspec import analyze_dbspec
from dbspec_cases_reader import read_cases  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
SECTIONS = ('canonical', 'normalize', 'invalid')


def join(lines, crlf, mixed=False):
    """Mirrors join in the generator: LF, CRLF when crlf, or alternating CRLF and LF with no final line end when mixed."""
    if mixed:
        last = len(lines) - 1
        return ''.join(line if i == last else line + ('\r\n' if i % 2 == 0 else '\n')
                       for i, line in enumerate(lines))
    end = '\r\n' if crlf else '\n'
    return end.join(lines) + end


def header_name(lines):
    return lines[0].split(' ')[2]


def vector_inputs(cases):
    """The (id, text, documents) of every analysis the vectors need, in file order (mirrors vectorInputs)."""
    inputs = []
    for section in SECTIONS:
        for case in cases[section]:
            main = case['documents'][case['main']]
            documents = {name: join(lines, case.get('crlf') is True, case.get('mixed') is True)
                         for name, lines in case['documents'].items() if name != case['main']}
            inputs.append((f"{section}/{case['id']}",
                           join(main, case.get('crlf') is True, case.get('mixed') is True), documents))
    for case in cases['sets']:
        everything = case['documents'] + case.get('external', [])
        for i, lines in enumerate(case['documents']):
            documents = {name: join(other, False) for name, other in case['parsing'].items()}
            for j, other in enumerate(everything):
                if j != i:
                    documents[header_name(other)] = join(other, False)
            inputs.append((f"sets/{case['id']}/{i + 1}", join(lines, False), documents))
    for case in cases['hashes']:
        for name in case['documents']:
            documents = {other: join(lines, False) for other, lines in case['documents'].items()
                         if other != name}
            inputs.append((f"hashes/{case['id']}/{name}", join(case['documents'][name], False), documents))
    return inputs


class SyntaxVectorTest(unittest.TestCase):
    def test_tokens_match_the_shared_vectors(self):
        with open(ROOT / 'tests' / 'dbspec' / 'syntax.json', encoding='utf-8') as handle:
            vectors = json.load(handle)
        self.assertEqual(sorted(vectors), ['cases', 'note', 'version'])
        self.assertEqual(vectors['version'], 1)
        expected = {}
        for case in vectors['cases']:
            self.assertEqual(sorted(case), ['id', 'tokens'])
            self.assertNotIn(case['id'], expected, f"{case['id']} is listed twice")
            expected[case['id']] = case['tokens']
        inputs = vector_inputs(read_cases())
        self.assertEqual(sorted(i for i, _, _ in inputs), sorted(expected),
                         'the vector ids and the cases of cases.json differ')
        failures = []
        for case_id, text, documents in inputs:
            found = [[t.line, t.start, t.end, t.token_class]
                     for t in analyze_dbspec(text, documents).tokens]
            if found != expected[case_id]:
                failures.append(f"{case_id}: want {expected[case_id]} got {found}")
        if failures:
            self.fail(f'{len(failures)} of {len(inputs)} differ:\n' + '\n'.join(failures))


if __name__ == '__main__':
    unittest.main()
