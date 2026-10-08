# The Python symbol extractor (tests/interfaces/python.py) reports the public declarations of a
# package in the form of tests/interfaces/typescript.mjs: a class, a function, a method, a field.
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

EXTRACTOR = Path(__file__).resolve().parent / 'python.py'


class PythonExtractorTest(unittest.TestCase):
    def extract(self, source: str) -> dict:
        with tempfile.TemporaryDirectory(prefix='interfaces-python-') as root:
            package = Path(root) / 'pkg'
            package.mkdir()
            (package / 'mod.py').write_text(source, encoding='utf-8')
            result = subprocess.run([sys.executable, str(EXTRACTOR), root, 'pkg'],
                                    capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)

    def test_public_names_match_the_symbol_file(self):
        # The contract contracts/symbols/python.json lists the public surface of the Python client. A module-level
        # helper that another module of the package imports is internal, so its name starts with `_`.
        root = Path(__file__).resolve().parents[2]
        result = subprocess.run([sys.executable, str(EXTRACTOR), str(root), 'clients/python/src'],
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        got = set(json.loads(result.stdout))
        want = set(json.loads((root / 'contracts/symbols/python.json').read_text(encoding='utf-8')))
        self.assertEqual(sorted(got - want), [], 'public names outside the contract; prefix an internal helper with _')
        self.assertEqual(sorted(want - got), [], 'contract names that the client does not declare')

    def test_reports_public_declarations_only(self):
        symbols = self.extract(
            'class Client:\n'
            '    limit: int\n'
            '    def _hidden(self) -> None:\n'
            '        pass\n'
            '    def query(self, name: str) -> list:\n'
            '        return []\n'
            '    @property\n'
            '    def size(self) -> int:\n'
            '        return 0\n'
            'def open_db(dsn: str) -> Client:\n'
            '    return Client()\n'
            'def _private() -> None:\n'
            '    pass\n')
        self.assertEqual(symbols['pkg/mod.py::Client'], 'class Client')
        self.assertEqual(symbols['pkg/mod.py::Client#field.limit'], 'int')
        self.assertEqual(symbols['pkg/mod.py::Client.query'], 'def query(self, name: str) -> list')
        self.assertEqual(symbols['pkg/mod.py::Client.size'], '@property def size(self) -> int')
        self.assertEqual(symbols['pkg/mod.py::open_db'], 'def open_db(dsn: str) -> Client')
        self.assertNotIn('pkg/mod.py::Client._hidden', symbols)
        self.assertNotIn('pkg/mod.py::_private', symbols)


    def test_a_typed_dict_record_reports_its_wire_types_and_its_base(self):
        symbols = self.extract(
            'from typing import NotRequired, TypedDict\n'
            'class Base(TypedDict):\n'
            '    kind: str\n'
            'class Request(Base):\n'
            '    count: int\n'
            '    tags: list[str]\n'
            '    by_name: dict[str, Base]\n'
            '    limit: NotRequired[int | None]\n'
            '    note: str | None\n')
        self.assertEqual(symbols['pkg/mod.py::Base#wire'], '{"kind":"text"}')
        self.assertEqual(symbols['pkg/mod.py::Request#wire'],
                         '{"@flatten":"Base","count":"integer","tags":"list<text>",'
                         '"by_name":"map<Base>","limit":"integer","note":"text"}')


if __name__ == '__main__':
    unittest.main()
