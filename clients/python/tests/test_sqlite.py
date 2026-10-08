# SQLite e2e: 생성된 model로 row를 만들고 읽고 고치고 지운다 (docs/usage.md).
# conformance runner가 세 database를 검사하므로 여기서는 SQLite만 확인한다.
import importlib.util
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

ORM_GEN = [sys.executable, str(ROOT / 'clients' / 'python' / 'bin' / 'orm-gen')]

# bench.dbs와 같은 모양의 최소 DDL. render가 Python에 오면(T43.4) 이 표를 대신한다.
DDL = """
CREATE TABLE "user" ("seq" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL);
CREATE TABLE "service" ("seq" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL);
CREATE TABLE "service_region" ("seq" INTEGER PRIMARY KEY AUTOINCREMENT,
  "service_seq" INTEGER NOT NULL, "name" TEXT NOT NULL);
CREATE TABLE "service_member" ("seq" INTEGER PRIMARY KEY AUTOINCREMENT,
  "service_seq" INTEGER NOT NULL, "user_seq" INTEGER NOT NULL);
CREATE TABLE "author" ("seq" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL,
  "description" TEXT NULL, "created_ts" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_ts" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "is_close" INTEGER NOT NULL DEFAULT 0, "is_display" INTEGER NOT NULL DEFAULT 0,
  "display_start_dt" TEXT NULL, "display_end_dt" TEXT NULL,
  "is_allday" INTEGER NOT NULL DEFAULT 0, "target_club_reader_count" INTEGER NOT NULL DEFAULT 0,
  "success_count" INTEGER NOT NULL DEFAULT 0, "reader_count" INTEGER NOT NULL DEFAULT 0,
  "read_count" INTEGER NOT NULL DEFAULT 0, "photo_url" TEXT NULL, "user_seq" INTEGER NOT NULL,
  "service_seq" INTEGER NOT NULL, "service_region_seq" INTEGER NOT NULL,
  "service_member_seq" INTEGER NOT NULL, "start_dt" TEXT NOT NULL,
  "end_dt" TEXT NOT NULL, "uuid" TEXT NULL, "is_single_work" INTEGER NOT NULL DEFAULT 0,
  "like_count" INTEGER NOT NULL DEFAULT 0, "aes_key_version" INTEGER NOT NULL DEFAULT 1,
  "aes_hex_email" TEXT NULL, "email_blind_index" TEXT NULL,
  "aes_hex_phone" TEXT NULL, "phone_blind_index" TEXT NULL, "price" INTEGER NULL,
  "ip" BLOB NULL, "gz_extend" BLOB NULL, "json_setting" TEXT NULL,
  "jsons_tags" TEXT NULL, "base64_extra" TEXT NULL, "serialize_data" TEXT NULL);
CREATE TABLE "composite_account" ("tenant_id" INTEGER NOT NULL,
  "account_id" INTEGER NOT NULL, "name" TEXT NOT NULL,
  PRIMARY KEY ("tenant_id", "account_id"));
CREATE TABLE "soft_record" ("seq" INTEGER PRIMARY KEY AUTOINCREMENT,
  "name" TEXT NOT NULL, "deleted_at" TEXT NULL);
CREATE TABLE "task" ("seq" INTEGER PRIMARY KEY AUTOINCREMENT, "title" TEXT NOT NULL,
  "state" TEXT NOT NULL);
"""

# audit record를 가진 문서 집합: audited table과 audit record table.
AUDIT_DOCS = """dbspec 1 audit

table change_log {
  id i64 identity
  actor varchar(64)
  primary key (id)
}

table audited_history {
  history_id i64 identity
  change varchar(8)
  seq i64
  name varchar(191)
  change_log_id i64 null
  previous_change_log_id i64 null
  primary key (history_id)
  index ix_audited_history_row (seq)
}

table audited_row {
  seq i64 identity
  name varchar(191)
  change_log_id i64
  primary key (seq)
  index ix_audited_change (change_log_id)
  foreign key fk_audited_change (change_log_id) references change_log (id) on delete restrict on update restrict
  settings {
    audit into audited_history column change_log_id references change_log action change previous previous_change_log_id
  }
}
"""


def generate(out: str, schema: Path):
    subprocess.run(ORM_GEN + ['gen', '--schema', str(schema), '--out', out],
                   capture_output=True, text=True, check=True)
    spec = importlib.util.spec_from_file_location(f'orm_models_{Path(out).name}',
                                                  str(Path(out) / 'models.py'))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def run_script(db, text: str) -> None:
    """여러 statement를 하나씩 실행한다."""
    for statement in text.split(';'):
        if statement.strip():
            db._connection.execute(statement, [])


class SqliteEndToEndTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix='orm-sqlite-')
        cls.addClassCleanup(tmp.cleanup)
        cls.out = tmp.name
        cls.models = generate(cls.out, ROOT / 'schema' / 'bench.dbs')
        cls.db = cls.models.connect(f'sqlite://{cls.out}/bench.sqlite3')
        run_script(cls.db, DDL)
        cls.db._connection.execute('INSERT INTO "user" ("name") VALUES (?)', ['u1'])
        cls.db._connection.execute('INSERT INTO "service" ("name") VALUES (?)', ['s7'])
        cls.db._connection.execute(
            'INSERT INTO "service_region" ("service_seq", "name") VALUES (?, ?)', [1, 'r1'])
        cls.db._connection.execute(
            'INSERT INTO "service_member" ("service_seq", "user_seq") VALUES (?, ?)',
            [1, 1])

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def author(self, name: str):
        return self.models.Author().connect(self.db).set_name(name) \
            .set_user_seq(1).set_service_seq(1).set_service_region_seq(1) \
            .set_service_member_seq(1).set_start_dt('2026-06-01 00:00:00.000000') \
            .set_end_dt('2026-06-02 00:00:00.000000')

    def test_write_cycle(self):
        created = self.author('cycle').set_read_count(10).new_label('made').create()
        seq = created.get_seq()
        self.assertEqual(created.get_name(), 'cycle')
        self.assertEqual(created.core.new_value('label'), 'made')
        loaded = self.models.Author().connect(self.db).add_all_columns().get_by_seq(seq)
        self.assertEqual(loaded.get_read_count(), 10)
        loaded.set_name('cycle-2').plus_read_count(3).update(True)
        # 첫 update가 update time을 지웠으므로 다시 쓰려면 row를 다시 읽는다.
        with self.assertRaisesRegex(Exception, 'CONFIG'):
            loaded.set_name('stale').update(True)
        again = self.models.Author().connect(self.db).get_by_seq(seq)
        self.assertEqual(again.get_name(), 'cycle-2')
        self.assertEqual(again.get_read_count(), 13)
        again.delete()
        with self.assertRaisesRegex(Exception, 'NO_ROWS'):
            self.models.Author().connect(self.db).get_by_seq(seq)

    def test_conditions_and_order(self):
        for i in range(4):
            self.author(f'cond-{i}').set_read_count(i * 100).create()
        rows = self.models.Author().connect(self.db).lk_name('cond-') \
            .order_by_read_count_desc().limit(0, 2).gets()
        self.assertEqual([row.get_read_count() for row in rows], [300, 200])
        count = self.models.Author().connect(self.db).lk_name('cond-').get_count()
        self.assertEqual(count, 4)

    def test_group_and_page(self):
        for i in range(5):
            self.author(f'page-{i}').set_is_close(i % 2 == 0).create()
        groups = self.models.Author().connect(self.db).lk_name('page-') \
            .group_by_is_close().order_by_is_close_asc().gets_count()
        self.assertEqual([(row.value('is_close'), row.count) for row in groups],
                         [(False, 2), (True, 3)])
        page = self.models.Author().connect(self.db).lk_name('page-') \
            .order_by_name_asc().gets_page(2, 2)
        self.assertEqual(page['totalCount'], 5)
        self.assertEqual(page['totalPages'], 3)
        self.assertEqual([row.get_name() for row in page['items']], ['page-2', 'page-3'])
        with self.assertRaisesRegex(Exception, 'CONFIG'):
            self.models.Author().connect(self.db).limit(0, 1).gets_page(1, 10)

    def test_creates_and_save_and_duplication(self):
        model = self.models.CompositeAccount().connect(self.db)
        rows = [self.models.CompositeAccount().set_tenant_id(900).set_account_id(i + 1)
                .set_name(f'c{i}') for i in range(3)]
        inserted = model.creates(rows)
        self.assertEqual(inserted, 3)
        model.set_tenant_id(900).set_account_id(1).set_name('dup') \
            .duplication(self.models.CompositeAccount().set_name('updated')).create()
        self.assertEqual(self.models.CompositeAccount().connect(self.db)
                         .get_by_tenant_id_and_account_id(900, 1).get_name(), 'updated')
        self.models.CompositeAccount().connect(self.db).set_tenant_id(900) \
            .set_account_id(3).set_name('saved').save()
        all = self.models.CompositeAccount().connect(self.db).tenant_id(900) \
            .order_by_account_id_asc().gets()
        all.delete()
        self.assertEqual(self.models.CompositeAccount().connect(self.db)
                         .tenant_id(900).get_count(), 0)

    def test_transaction_rollback(self):
        boom = RuntimeError('boom')
        log = []
        self.db.subscribe(lambda event: log.append(event.kind))

        def work():
            self.author('tx-outer').create()
            try:
                self.db.transaction(lambda: self._inner(boom), {'retry': 0})
            except RuntimeError as error:
                if error is not boom:
                    raise
            raise boom

        with self.assertRaises(RuntimeError):
            self.db.transaction(work, {'retry': 0})
        self.assertEqual(log[0], 'begin')
        self.assertIn('savepoint', log)
        self.assertEqual(log[-1], 'rollback')
        self.assertEqual(self.models.Author().connect(self.db)
                         .name('tx-outer').get_count(), 0)

    def _inner(self, boom):
        self.author('tx-inner').create()
        raise boom

    def test_statement_events_of_a_commit(self):
        log = []
        unsubscribe = self.db.subscribe(
            lambda event: log.append({'sql': event.sql, 'kind': event.kind,
                                      'transaction': event.transaction,
                                      'binds': list(event.binds),
                                      'tables': list(event.tables)}))

        def work():
            self.author('tx-commit').create()
        self.db.transaction(work, {'retry': 0})
        unsubscribe()
        kinds = [entry['kind'] for entry in log]
        self.assertEqual(kinds[0], 'begin')
        self.assertEqual(kinds[-1], 'commit')
        insert = next(entry for entry in log if entry['kind'] == 'insert')
        self.assertEqual(insert['tables'], ['author'])
        self.assertIsNotNone(insert['transaction'])
        self.assertEqual(insert['binds'][0], 'tx-commit')

    def test_relations_and_recursive_delete(self):
        service = self.models.Service().connect(self.db).set_name('rel').create()
        for i in range(2):
            self.models.ServiceMember().connect(self.db) \
                .set_service_seq(service.get_seq()).set_user_seq(i + 1).create()
        loaded = self.models.Service().connect(self.db) \
            .relations(self.models.ServiceMember().match_seq_with_service_seq()) \
            .get_by_seq(service.get_seq())
        members = loaded.get_service_member_models()
        self.assertEqual(members.length, 2)
        loaded.delete(True)
        self.assertEqual(self.models.ServiceMember().connect(self.db)
                         .get_count_by_service_seq(service.get_seq()), 0)

    def test_external_relation(self):
        main = self.author('external-main').set_user_seq(1).set_read_count(0).create()
        self.author('external-other').set_user_seq(1).set_read_count(7).create()
        rows = self.models.Author().connect(self.db).remove_all_columns() \
            .add_column_seq().add_column_name() \
            .relation(self.models.Author().match_user_seq_with_user_seq()
                      .alias_writer().connect(self.db)
                      .remove_all_columns().add_column_read_count()) \
            .get_by_seq(main.get_seq())
        writer = rows.get_writer()
        self.assertIn(writer.get_read_count(), (0, 7))

    def test_restore(self):
        created = self.models.SoftRecord().connect(self.db).set_name('restore').create()
        seq = created.get_seq()
        created.set_deleted_at('2026-01-02 03:04:05.000000').update()
        with self.assertRaisesRegex(Exception, 'NO_ROWS'):
            self.models.SoftRecord().connect(self.db).get_by_seq(seq)
        restored = self.models.SoftRecord().connect(self.db).set_seq(seq) \
            .set_name('restore-2').restore()
        self.assertEqual(restored.get_name(), 'restore-2')
        again = self.models.SoftRecord().connect(self.db).set_seq(seq).restore()
        self.assertEqual(again.get_seq(), seq)
        self.assertEqual(self.models.SoftRecord().connect(self.db)
                         .name('restore-2').get_count(), 1)

    def test_for_update_locks_the_row(self):
        def work():
            rows = self.models.Author().connect(self.db).name('cond-0').for_update() \
                .gets()
            return rows.length
        length = self.db.transaction(work, {'retry': 0})
        self.assertGreaterEqual(length, 1)

    def test_get_query(self):
        statement = self.models.Author().connect(self.db).service_seq(1) \
            .and_lk_name('x').order_by_seq_desc().limit(0, 5).get_query()
        self.assertTrue(statement['sql'].startswith('SELECT'))
        self.assertEqual(statement['binds'][1], '%x%')


class SqliteAuditTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix='orm-audit-')
        cls.addClassCleanup(tmp.cleanup)
        cls.out = tmp.name
        document = Path(cls.out) / 'audit.dbs'
        document.write_text(AUDIT_DOCS)
        cls.models = generate(cls.out, document)
        cls.db = cls.models.connect(f'sqlite://{cls.out}/audit.sqlite3')
        run_script(cls.db, 'CREATE TABLE "change_log" ("id" INTEGER PRIMARY KEY '
                           'AUTOINCREMENT, "actor" TEXT NOT NULL); '
                           'CREATE TABLE "audited_row" ("seq" INTEGER PRIMARY KEY '
                           'AUTOINCREMENT, "name" TEXT NOT NULL, "change_log_id" '
                           'INTEGER NULL)')

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def test_audit_requires_a_source(self):
        with self.assertRaisesRegex(Exception, 'CONFIG'):
            self.db.transaction(lambda: None, {'retry': 0, 'audit': {'actor': 'x'}})

    def test_audit_record_is_inserted_and_bound(self):
        self.db.audit_source = lambda: {'actor': 'runner'}

        def work():
            self.models.AuditedRow().set_name('logged').create()
            return self.models.AuditedRow().connect(self.db).get_count()

        try:
            rows = self.db.transaction(work, {'retry': 0, 'audit': {'actor': 'job'}})
            self.assertEqual(rows, 1)
            logs = self.db._connection.execute('SELECT "id", "actor" FROM "change_log"',
                                               [])
            # 같은 column이면 transaction의 값이 audit source의 값을 이긴다.
            self.assertEqual(logs['rows'][0][1], 'job')
            bound = self.db._connection.execute(
                'SELECT "change_log_id" FROM "audited_row"', [])
            self.assertEqual(bound['rows'][0][0], logs['rows'][0][0])
        finally:
            self.db.audit_source = None


if __name__ == '__main__':
    unittest.main()
