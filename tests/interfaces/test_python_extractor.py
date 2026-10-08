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


if __name__ == '__main__':
    unittest.main()
