# The shared set reader vectors of tests/dbspec/set-files.json (docs/dbspec.md "Document sets"): every
# case builds its file tree in a fresh temporary directory, with real symbolic and hard links, and runs
# read_dbspec_set on the tree root joined with the case's `set`. The vector file is read strictly: an
# unknown or missing field is an error, and every case runs.
import json
import os
import posixpath
import shutil
import sys
import tempfile
import unittest
from pathlib import Path


from polyspec.orm.dbspec import read_dbspec_set
from vector_case import VectorCase, vector_tests

ROOT = Path(__file__).resolve().parents[3]
VECTORS = ROOT / 'tests' / 'dbspec' / 'set-files.json'


class VectorError(Exception):
    pass


def _exact(value, keys, where):
    """Checks that `value` is an object with exactly `keys`."""
    if not isinstance(value, dict):
        raise VectorError(f'{where}: not an object')
    if set(value) != set(keys):
        raise VectorError(f'{where}: fields {sorted(value)}, want {sorted(keys)}')
    return value


def _string(value, where):
    if not isinstance(value, str):
        raise VectorError(f'{where}: not a string')
    return value


def _strings(value, where):
    if not isinstance(value, list):
        raise VectorError(f'{where}: not a list')
    return [_string(item, f'{where}[{i}]') for i, item in enumerate(value)]


def _no_duplicates(pairs):
    keys = [key for key, _ in pairs]
    if len(keys) != len(set(keys)):
        raise VectorError(f'a key appears twice in {keys}')
    return dict(pairs)


def load_cases():
    data = json.loads(VECTORS.read_text(encoding='utf-8'), object_pairs_hook=_no_duplicates)
    _exact(data, ('version', 'note', 'cases'), 'set-files.json')
    if data['version'] != 1:
        raise VectorError(f'set-files.json: version {data["version"]!r}')
    _string(data['note'], 'note')
    if not isinstance(data['cases'], list) or not data['cases']:
        raise VectorError('set-files.json: cases is not a non-empty list')
    cases = []
    ids = set()
    for index, case in enumerate(data['cases']):
        where = f'cases[{index}]'
        _exact(case, ('id', 'tree', 'set', 'want'), where)
        case_id = _string(case['id'], f'{where}.id')
        if case_id in ids:
            raise VectorError(f'{where}: id {case_id} appears twice')
        ids.add(case_id)
        tree = case['tree']
        if not isinstance(tree, dict):
            raise VectorError(f'{case_id}: tree is not an object')
        entries = []
        for path, entry in tree.items():
            if not isinstance(entry, dict) or len(entry) != 1:
                raise VectorError(f'{case_id}: tree entry {path} has not exactly one field')
            (kind, value), = entry.items()
            if kind not in ('file', 'hex', 'symlink', 'hardlink'):
                raise VectorError(f'{case_id}: tree entry {path} has the unknown field {kind}')
            entries.append((path, kind, _string(value, f'{case_id}: tree entry {path}')))
        want = case['want']
        if isinstance(want, dict) and 'errors' in want:
            _exact(want, ('errors',), f'{case_id}.want')
            if not isinstance(want['errors'], list) or not want['errors']:
                raise VectorError(f'{case_id}: errors is not a non-empty list')
            errors = []
            for i, error in enumerate(want['errors']):
                _exact(error, ('rule', 'path'), f'{case_id}.want.errors[{i}]')
                errors.append((_string(error['rule'], f'{case_id} rule'),
                               _string(error['path'], f'{case_id} path')))
            want = ('errors', errors)
        else:
            _exact(want, ('documents', 'external'), f'{case_id}.want')
            want = ('set', _strings(want['documents'], f'{case_id}.want.documents'),
                    _strings(want['external'], f'{case_id}.want.external'))
        cases.append((case_id, entries, _string(case['set'], f'{case_id}.set'), want))
    return cases


def build_tree(root, entries):
    """Writes the tree under `root` in its written order and gives each regular file's bytes by its tree
    path (a hard link has the bytes of its file)."""
    contents = {}
    for path, kind, value in entries:
        target = os.path.join(root, *path.split('/'))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        if kind == 'file':
            data = value.encode('utf-8')
        elif kind == 'hex':
            data = bytes.fromhex(value)
        elif kind == 'symlink':
            resolved = os.path.join(os.path.dirname(target), *value.split('/'))
            os.symlink(value.replace('/', os.sep), target,
                       target_is_directory=os.path.isdir(resolved))
            continue
        else:
            if value not in contents:
                raise VectorError(f'hard link {path} names {value}, which is not an earlier file')
            os.link(os.path.join(root, *value.split('/')), target)
            contents[path] = contents[value]
            continue
        with open(target, 'xb') as handle:
            handle.write(data)
        contents[path] = data
    return contents


def check_case(test: unittest.TestCase, case) -> None:
    """Builds the case's tree in a fresh temporary directory and reads its set."""
    _case_id, entries, set_path, want = case
    root = tempfile.mkdtemp(prefix='orm-set-')
    try:
        contents = build_tree(root, entries)
        result, errors = read_dbspec_set(root + '/' + set_path)
        got_errors = [(error.rule, error.path) for error in errors]
        if want[0] == 'errors':
            test.assertIsNone(result)
            test.assertEqual(got_errors, [(rule, root + '/' + path) for rule, path in want[1]])
            for error in errors:
                test.assertIn(error.path, error.message)
            return
        test.assertEqual(got_errors, [])
        for files, paths in ((result.documents, want[1]), (result.external, want[2])):
            test.assertEqual([file.path for file in files], [root + '/' + path for path in paths])
            for file, path in zip(files, paths):
                test.assertEqual(file.data, contents[posixpath.normpath(path)])
    finally:
        shutil.rmtree(root)


class Case(VectorCase):
    """A case of the vector file of this module."""


def load_tests(loader: unittest.TestLoader, tests: unittest.TestSuite, pattern: object) -> unittest.TestSuite:
    """One test for each case of set-files.json, named by the case id."""
    tests.addTests(vector_tests(Case, load_cases(), check_case, lambda case: case[0]))
    return tests

if __name__ == '__main__':
    unittest.main()
