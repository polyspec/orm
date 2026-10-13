# The tests run against the package installed into the venv (PRINCIPLES.md, S3): no file under this folder
# reads or changes sys.path or passes a PYTHONPATH.
import ast
import unittest
from pathlib import Path

TESTS = Path(__file__).resolve().parent


def path_changes(source, name):
    found = []
    for node in ast.walk(ast.parse(source, name)):
        if (isinstance(node, ast.Attribute) and node.attr == 'path'
                and isinstance(node.value, ast.Name) and node.value.id == 'sys'):
            found.append(f'{name}:{node.lineno}: sys.path')
        elif isinstance(node, ast.Constant) and node.value == 'PYTHONPATH':
            found.append(f'{name}:{node.lineno}: PYTHONPATH')
    return found


class NoPathChangeTest(unittest.TestCase):
    def test_refuses_a_path_change(self):
        self.assertEqual(path_changes("import sys\nsys.path.insert(0, 'src')\n", 'probe.py'),
                         ['probe.py:2: sys.path'])
        self.assertEqual(path_changes("env = {'PYTHONPATH': 'src'}\n", 'probe.py'),
                         ['probe.py:1: PYTHONPATH'])

    def test_no_test_changes_the_path(self):
        found = []
        for file in sorted(TESTS.rglob('*.py')):
            if file.name == Path(__file__).name:
                continue  # this file names the refused forms in its own rejecting case
            found += path_changes(file.read_text(encoding='utf-8'), str(file.relative_to(TESTS)))
        self.assertEqual(found, [])


if __name__ == '__main__':
    unittest.main()
