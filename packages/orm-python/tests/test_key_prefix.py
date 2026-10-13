# The chain names of every key prefix resolve on an instance of a generated model without a scanned
# call (T156): the generator declares them from the schema, and Python resolves them at run time.
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PYTHON_SRC = Path(__file__).resolve().parents[1] / 'src'
ORDERED_JSON = Path(__file__).resolve().parents[4] / 'ordered-json' / 'packages' / 'ordered-json-python' / 'src'
ORM_GEN = [sys.executable, str(Path(__file__).resolve().parents[1] / 'bin' / 'orm-gen')]
ENV = dict(os.environ, PYTHONPATH=os.pathsep.join(
    p for p in [str(ORDERED_JSON), str(PYTHON_SRC), os.environ.get('PYTHONPATH', '')] if p))


class KeyPrefixTest(unittest.TestCase):
    def test_key_prefix_names_resolve_without_a_scan(self):
        with tempfile.TemporaryDirectory(prefix='orm-key-prefix-') as tmp:
            set_dir = Path(tmp) / 'set'
            set_dir.mkdir()
            (set_dir / 'audit_columns.dbs').write_text(
                (ROOT / 'contracts' / 'fixtures' / 'audit_columns.dbs').read_text())
            (set_dir / 'dbspec-set.json').write_text('{"schema":1,"documents":["audit_columns.dbs"]}\n')
            empty = Path(tmp) / 'empty.py'
            empty.write_text('')
            out = Path(tmp) / 'out'
            result = subprocess.run(ORM_GEN + ['gen', '--set', str(set_dir / 'dbspec-set.json'), '--out', str(out),
                                               '--scan', str(empty)], env=ENV, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            code = (
                'import sys; sys.path.insert(0, %r); import out.models as m\n'
                'print(callable(getattr(m.Card(), "audit_seq", None)), callable(getattr(m.CardHistory(), "seq", None)))\n'
            ) % tmp
            run = subprocess.run([sys.executable, '-c', code], env=ENV, capture_output=True, text=True)
            self.assertEqual(run.stdout.strip(), 'True True', run.stderr)


if __name__ == '__main__':
    unittest.main()
