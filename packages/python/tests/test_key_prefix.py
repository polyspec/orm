# The chain names of every key prefix resolve on an instance of a generated model without a scanned
# call (T156): the generator declares them from the schema, and Python resolves them at run time.
import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from . import testcase

ROOT = Path(__file__).resolve().parents[3]
ORM_GEN = [sys.executable, '-m', 'polyspec.orm.bin_orm_gen']


class KeyPrefixTest(unittest.TestCase):
    deadline = testcase.PROCESS
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
                                               '--scan', str(empty)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            spec = importlib.util.spec_from_file_location('key_prefix_models', str(out / 'models.py'))
            models = importlib.util.module_from_spec(spec)
            sys.modules['key_prefix_models'] = models
            self.addCleanup(sys.modules.pop, 'key_prefix_models', None)
            spec.loader.exec_module(models)
            self.assertTrue(callable(getattr(models.Card(), 'audit_seq', None)))
            self.assertTrue(callable(getattr(models.CardHistory(), 'seq', None)))


if __name__ == '__main__':
    testcase.main()
