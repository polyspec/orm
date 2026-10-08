# orm-gen 생성기 검사: schema/bench.dbs 문서 집합에서 models.py를 만들고,
# 생성 module이 chain 문법을 해석하는지 확인한다 (unittest).
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
_ORDERED_JSON = Path(__file__).resolve().parents[4] / 'ordered-json' / 'python' / 'src'
if _ORDERED_JSON.is_dir():
    sys.path.insert(0, str(_ORDERED_JSON))

ORM_GEN = [sys.executable, str(ROOT / 'packages' / 'orm-python' / 'bin' / 'orm-gen')]
# orm-gen은 하위 프로세스이므로 이 test의 sys.path를 받지 못한다. sibling ordered-json을 PYTHONPATH로
# 넘긴다(docs/checklist.md T43.5-6-1). 외부 PYTHONPATH가 있으면 뒤에 덧붙인다.
ORM_GEN_ENV = dict(os.environ, PYTHONPATH=os.pathsep.join(
    p for p in [str(_ORDERED_JSON), os.environ.get('PYTHONPATH', '')] if p))


class OrmGenTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix='orm-gen-')
        cls.addClassCleanup(tmp.cleanup)
        cls.out = tmp.name
        result = subprocess.run(env=ORM_GEN_ENV, args=ORM_GEN + ['gen', '--schema',
                                           str(ROOT / 'schema' / 'bench.dbs'),
                                           '--out', cls.out],
                                capture_output=True, text=True, check=True)
        sys.path.insert(0, cls.out)
        cls.addClassCleanup(sys.path.remove, cls.out)

    def test_generated_module_imports_and_builds_the_model(self):
        import models
        self.assertEqual(models.MANIFEST_HASH,
                         'sha256:74501d5f3aa5050f7af67198114fa4a56292d725e7a244d5901750271b2c41fa')
        author = models.Author()
        self.assertEqual(author.entity_def.entity.name, 'author')
        self.assertEqual(len(models.model.entities), 12)
        self.assertTrue(models.SCHEMA.manifest_text.startswith('dbspec 1 bench'))

    def test_fixed_column_methods(self):
        import models
        user = models.User()
        user.set_name('tester')
        self.assertEqual(user.core.values, {'name': 'tester'})
        self.assertEqual([(spec.column, spec.value) for spec in user.core.sets],
                         [('name', 'tester')])
        user.get_name  # 생성된 getter가 있다
        user.add_column_name().remove_column_name()
        self.assertEqual(user.core.columns_add, ['name'])
        self.assertEqual(user.core.columns_remove, ['name'])
        author = models.Author()
        author.plus_like_count(3)
        self.assertEqual([(spec.column, spec.value, spec.plus) for spec in author.core.sets],
                         [('like_count', 3, True)])

    def test_chain_conditions(self):
        import models
        author = models.Author()
        author.service_seq(7)
        author.and_is_close(False)
        author.or_gt_read_count(6)
        items = author.core.where.items
        self.assertEqual([(item['pred']['column'], item['pred']['op'], item['conn'])
                          for item in items],
                         [('service_seq', 'eq', ''), ('is_close', 'eq', 'and'),
                          ('read_count', 'gt', 'or')])
        other = models.Author()
        other.between_price(['1.0', '2.0'])
        self.assertEqual(other.core.where.items[-1]['pred']['kind'], 'between')
        third = models.Author()
        third.ne_uuid('x')
        self.assertEqual(third.core.where.items[-1]['pred']['op'], 'not_eq')

    def test_order_limit_and_match(self):
        import models
        author = models.Author()
        author.order_by_seq_asc()
        self.assertEqual(author.core.order, [{'column': 'seq', 'desc': False, 'fn': None}])
        author.limit(0, 3)
        self.assertEqual(author.core.limit, {'offset': 0, 'count': 3})
        author.match_user_seq_with_seq()
        self.assertEqual(author.core.matches, [{'left': 'user_seq', 'right': 'seq'}])
        author.and_not(lambda m: m.name('excluded'))
        self.assertTrue(author.core.where.items[-1]['group'].not_)

    def test_scan_reports_unknown_model_methods(self):
        source = Path(self.out) / 'scan_probe.py'
        source.write_text('from models import Author\n'
                          'author = Author()\n'
                          'author.not_a_model_method()\n', encoding='utf-8')
        result = subprocess.run(env=ORM_GEN_ENV, args=ORM_GEN + ['gen', '--schema',
                                           str(ROOT / 'schema' / 'bench.dbs'),
                                           '--out', self.out, '--scan', str(source)],
                                capture_output=True, text=True)
        source.unlink()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Author.not_a_model_method', result.stderr)

    def test_check_reports_a_missing_or_differing_file(self):
        with tempfile.TemporaryDirectory(prefix='orm-gen-missing-') as missing:
            result = subprocess.run(env=ORM_GEN_ENV, args=ORM_GEN + ['gen', '--schema',
                                               str(ROOT / 'schema' / 'bench.dbs'),
                                               '--out', missing, '--check'],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn('missing:', result.stdout)
        result = subprocess.run(env=ORM_GEN_ENV, args=ORM_GEN + ['gen', '--schema',
                                           str(ROOT / 'schema' / 'bench.dbs'),
                                           '--out', self.out, '--check'],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
