# Db.with_request_hook의 공유 case(docs/usage.md "Request hook")를 contracts/fixtures/request_hook.dbs로 SQLite에서
# 실행한다. hook은 handle의 각 request를 plan 직전에 받아 predicate, assignment, parameter를 더할 수 있다.
# case 이름은 다른 client와 같다: without_hook, read_filter, insert_assign, loaded_row_writes, invalid_param.
import os
import sys
import tempfile
import unittest
from pathlib import Path

from test_sqlite import generate_document

ROOT = Path(__file__).resolve().parents[3]
PACKAGE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE / 'src'))

from polyspec.orm.database import Db  # noqa: E402
from polyspec.orm.errors import OrmError  # noqa: E402

READS = ('one', 'all', 'count', 'paginate')


def and_where(query: dict, pred: dict) -> None:
    """query의 where에 pred를 AND로 더한다. 있던 where는 group item 하나로 감싼다."""
    where = query.get('where')
    if not where or not where.get('items'):
        query['where'] = {'items': [{'pred': pred}]}
        return
    query['where'] = {'items': [{'group': where}, {'pred': {**pred, 'conn': 'and'}}]}


def part_filter(value: str, kinds=READS):
    """kinds의 request에 part eq value를 더하는 hook이다."""
    def hook(request, add_param):
        if request['kind'] in kinds:
            and_where(request, {'column': 'part', 'op': 'eq', 'p': add_param(value)})
        return request
    return hook


class RequestHookTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix='orm-request-hook-')
        cls.addClassCleanup(tmp.cleanup)
        cls.dir = tmp.name
        cls.models = generate_document(os.path.join(tmp.name, 'models'), ROOT / 'contracts' / 'fixtures' / 'request_hook.dbs')

    def setUp(self):
        path = os.path.join(self.dir, f'{self._testMethodName}.sqlite3')
        self.db = Db.connect_schema(f'sqlite://{path}', self.models.SCHEMA)
        self.addCleanup(self.db.close)
        self.db.utils().schema().install(self.models.SCHEMA)
        for part, label in (('a', 'a1'), ('a', 'a2'), ('b', 'b1')):
            self.item(self.db).set_part(part).set_label(label).create()

    def item(self, db):
        return self.models.HookItem().connect(db)

    def labels(self, db) -> list:
        return sorted(row.get_label() for row in self.item(db).gets())

    def test_without_hook(self):
        self.assertEqual(self.labels(self.db), ['a1', 'a2', 'b1'])
        self.assertEqual(self.item(self.db).get_count(), 3)
        self.db.with_request_hook(part_filter('a'))
        self.assertEqual(self.labels(self.db), ['a1', 'a2', 'b1'], 'the connection keeps no hook')
        self.assertEqual(self.item(self.db).get_count(), 3)

    def test_read_filter(self):
        hooked = self.db.with_request_hook(part_filter('a'))
        self.assertEqual(self.labels(hooked), ['a1', 'a2'])
        self.assertEqual(self.item(hooked).get_count(), 2)
        page = self.item(hooked).gets_page(1, 10)
        self.assertEqual(page['totalCount'], 2)
        self.assertEqual(len(page['items']), 2)
        self.assertEqual(self.labels(self.db.with_request_hook(part_filter('b'))), ['b1'])

    def test_insert_assign(self):
        def hook(request, add_param):
            if request['kind'] == 'insert':
                request['set'].append({'column': 'part', 'p': add_param('h')})
                for row in request.get('rows') or []:
                    row.append(add_param('h'))
            return request
        hooked = self.db.with_request_hook(hook)
        self.item(hooked).set_label('one').create()
        self.item(hooked).creates([self.models.HookItem().set_label('bulk1'),
                                   self.models.HookItem().set_label('bulk2')])
        stored = {row.get_label(): row.get_part() for row in self.item(self.db).gets()}
        self.assertEqual({k: v for k, v in stored.items() if v == 'h'},
                         {'one': 'h', 'bulk1': 'h', 'bulk2': 'h'})
        self.assertEqual(len(stored), 6)

    def test_loaded_row_writes(self):
        seen = []

        def hook(request, add_param):
            seen.append(request['kind'])
            if request['kind'] in ('update', 'delete'):
                and_where(request, {'column': 'part', 'op': 'eq', 'p': add_param('none')})
            return request
        hooked = self.db.with_request_hook(hook)
        row = self.item(hooked).get_by_label('a1')
        self.assertIn('one', seen)
        row.set_label('changed').update()
        self.assertIn('update', seen)
        self.assertEqual(self.labels(self.db), ['a1', 'a2', 'b1'], 'the hooked update matched no row')
        row.delete()
        self.assertIn('delete', seen)
        self.assertEqual(self.item(self.db).get_count(), 3, 'the hooked delete matched no row')
        seen.clear()
        count = hooked.transaction(lambda: self.models.HookItem().get_count())
        self.assertEqual(count, 3)
        self.assertEqual(seen, ['count'], 'a model without a connection runs through the handle of the transaction')

    def test_invalid_param(self):
        events = []
        self.db.subscribe(events.append)

        def hook(request, add_param):
            and_where(request, {'column': 'part', 'op': 'eq', 'p': request['n_params'] + 5})
            return request
        with self.assertRaises(OrmError) as raised:
            self.item(self.db.with_request_hook(hook)).get_count()
        self.assertEqual(raised.exception.code, 'IR_INVALID')
        self.assertEqual(events, [], 'no statement runs')


if __name__ == '__main__':
    unittest.main()
