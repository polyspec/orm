<?php
declare(strict_types=1);
// addTablesAndColumns를 SQLite, MySQL, PostgreSQL에서 확인한다(docs/schema.md "Adding tables and
// columns"). case database는 다른 set addcol_log의 table과 addcol set version 1의 table을 row와
// 함께 가진다. version 2로 addTablesAndColumns를 부르면 있는 table에 빠진 null이거나 default가
// 있는 column을 더하고, row를 지키며, 바뀐 audit table의 trigger가 새 column을 기록하고, 없는
// table을 index, foreign key, check, audit trigger와 함께 만들며, 다른 set의 table은 그대로
// 둔다. 다시 부르면 아무것도 더하지 않는다. 있는 table에 빠진 index는 더하고, 빠진 unique key는
// 그 이유를 적은 SCHEMA_DIFFERS다. 다른 차이가 있는 set은 아무것도 바꾸기 전에
// SCHEMA_DIFFERS다. fixture는 contracts/fixtures/add_tables_and_columns/*.dbs다. 각 case는 자기
// case database(case_database.php)에서 실행하며 ORM_TEST_MYSQL_DSN이나 ORM_TEST_POSTGRES_DSN이
// 없으면 실패한다.
// Usage: packages/php/vendor/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/AddTablesAndColumnsTest.php [--filter <case>]
require_once __DIR__ . '/case_database.php';

use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Schema;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\DataProvider;

#[Medium]
final class AddTablesAndColumnsTest extends TestCase
{
    private const ADDED = [
        'addcol_extra', 'addcol_extra_history',
        'addcol_item.note', 'addcol_item.priority', 'addcol_item.archived', 'addcol_item.status',
        'addcol_item_history.note', 'addcol_item_history.priority', 'addcol_item_history.archived', 'addcol_item_history.status',
        'addcol_tag.color',
    ];
    private const DIFFERS = ['required', 'removed', 'changed', 'nullable', 'default', 'unique', 'reorder'];
    // index.dbs가 version 1에 더하는 column과 index다. column 뒤에 index가 온다.
    private const ADDED_INDEX = ['addcol_item.note', 'addcol_item.ix_addcol_item_label', 'addcol_item_history.note'];
    private const MISSING_UNIQUE = 'add_unique addcol_item.uq_addcol_item_label: a missing unique key can fail on the existing rows; add it with a plan';

    private static function check(bool $ok, string $message): void
    {
        \PHPUnit\Framework\Assert::assertTrue($ok, $message);
    }

    /** call이 던진 OrmException이다. 오류가 없으면 null이다. */
    private static function thrown(callable $f): ?OrmException
    {
        try {
            $f();
        } catch (OrmException $e) {
            return $e;
        }
        return null;
    }

    /** contracts/fixtures/add_tables_and_columns/$name.dbs의 schema 값이다. */
    private static function fixture(string $name): Schema
    {
        $path = dirname(__DIR__, 3) . "/contracts/fixtures/add_tables_and_columns/$name.dbs";
        $read = Dbspec::readFile($path);
        if ($read->text === null) {
            throw new RuntimeException("cannot read $path");
        }
        $manifest = Dbspec::manifest(RuntimeModel::parse(["$name.dbs" => $read->text]));
        if ($manifest->manifest === null) {
            throw new RuntimeException("$path: " . json_encode($manifest->diagnostics));
        }
        return new Schema($manifest->manifest->manifestText, $manifest->manifest->manifestHash);
    }

    /** connection의 PDO로 query가 돌려주는 수를 읽는다. */
    private static function count_of(Db $db, string $sql): int
    {
        return (int) $db->pdo()->query($sql)->fetchColumn();
    }

    /**
     * case database에 addcol_log와 version 1을 설치하고 log row 하나, audit 기록 1로 item 하나, 그
     * item의 tag와 그 tag의 자식 tag를 쓴 연결이다. item의 audit column은 audit 기록 table의 행을
     * foreign key로 가리키므로 audit 기록을 먼저 쓴다.
     */
    private static function installed(string $dsn): Db
    {
        $db = Orm::connect($dsn, new Config());
        $db->utils()->schema()->install(self::fixture('log'));
        $db->utils()->schema()->install(self::fixture('v1'));
        $pdo = $db->pdo();
        $pdo->exec("INSERT INTO addcol_log_entry (message) VALUES ('kept')");
        $pdo->exec("INSERT INTO audit (actor) VALUES ('setup')");
        $pdo->exec("INSERT INTO addcol_item (ref, label, created_at, audit_seq) VALUES ('item-1', 'first', '2026-01-01 00:00:00.000000', 1)");
        $pdo->exec("INSERT INTO addcol_tag (item_id, name) VALUES (1, 'red')");
        $pdo->exec("INSERT INTO addcol_tag (item_id, parent_id, name) VALUES (1, 1, 'child')");
        return $db;
    }

    private static function addTablesAndColumns(string $dsn, string $driver): void
    {
        $db = self::installed($dsn);
        try {
            $added = $db->utils()->schema()->addTablesAndColumns(self::fixture('v2'));
            self::check($added === self::ADDED, 'addTablesAndColumns = ' . json_encode($added));
            // row는 그대로이고 새 column은 NULL이거나 default다.
            $items = self::count_of($db, "SELECT COUNT(*) FROM addcol_item WHERE ref = 'item-1' AND label = 'first' AND note IS NULL AND priority = 3 AND archived = false AND status = 'new'");
            self::check($items === 1, "items with their values and the new defaults $items");
            self::check(self::count_of($db, 'SELECT COUNT(*) FROM addcol_tag WHERE color IS NULL') === 2, 'tags with a null color');
            self::check(self::count_of($db, "SELECT COUNT(*) FROM addcol_log_entry WHERE message = 'kept'") === 1, 'log entries');
            // SQLite는 foreign key를 끄고 table을 다시 만들었다. 연결이 다시 켰는지 본다.
            $orphan = null;
            try {
                $db->pdo()->exec("INSERT INTO addcol_tag (item_id, name) VALUES (999, 'orphan')");
            } catch (PDOException $e) {
                $orphan = $e;
            }
            self::check($orphan !== null, 'a tag of a missing item was written');
            // audit trigger는 새 column을 기록한다.
            $db->pdo()->exec("INSERT INTO audit (actor) VALUES ('update')");
            $db->pdo()->exec("UPDATE addcol_item SET note = 'later', priority = 4, audit_seq = 2 WHERE id = 1");
            $history = self::count_of($db, "SELECT COUNT(*) FROM addcol_item_history WHERE history_action = 'update' AND previous_audit_seq = 1 AND audit_seq = 2 AND note = 'later' AND priority = 4 AND status = 'new'");
            self::check($history === 1, "history rows of the update with the new columns $history");
            // 새 table은 index, foreign key, check, audit trigger와 함께 만들어졌다.
            $db->pdo()->exec("INSERT INTO audit (actor) VALUES ('extra')");
            $db->pdo()->exec("INSERT INTO addcol_extra (item_id, label, audit_seq) VALUES (1, 'extra', 3)");
            $inserted = self::count_of($db, "SELECT COUNT(*) FROM addcol_extra_history WHERE history_action = 'insert' AND previous_audit_seq IS NULL AND audit_seq = 3 AND item_id = 1 AND label = 'extra'");
            self::check($inserted === 1, "history rows of the insert into the created table $inserted");
            foreach ([
                "INSERT INTO addcol_extra (item_id, label, audit_seq) VALUES (999, 'orphan', 3)" => 'foreign key',
                "INSERT INTO addcol_extra (item_id, label, audit_seq) VALUES (1, 'extra', 999)" => 'audit foreign key',
                "INSERT INTO addcol_extra (item_id, label, audit_seq) VALUES (1, '', 3)" => 'check',
                'DELETE FROM addcol_extra' => 'audit delete',
            ] as $statement => $what) {
                $refused = null;
                try {
                    $db->pdo()->exec($statement);
                } catch (PDOException $e) {
                    $refused = $e;
                }
                self::check($refused !== null, "the $what of the created table accepted $statement");
            }
            self::check(self::count_of($db, 'SELECT COUNT(*) FROM addcol_extra') === 1, 'rows of the created table');
            $again = $db->utils()->schema()->addTablesAndColumns(self::fixture('v2'));
            self::check($again === [], 'repeated addTablesAndColumns = ' . json_encode($again));
            // 모든 table이 있으므로 install은 아무것도 바꾸지 않는다(docs/schema.md "Schema installation").
            $install = self::thrown(fn() => $db->utils()->schema()->install(self::fixture('v2')));
            self::check($install === null, 'install of version 2 over its tables: ' . ($install?->getMessage() ?? ''));
        } finally {
            $db->close();
        }
    }

    private static function addTablesAndColumnsDiffers(string $dsn, string $driver): void
    {
        $db = self::installed($dsn);
        try {
            foreach (self::DIFFERS as $name) {
                $e = self::thrown(fn() => $db->utils()->schema()->addTablesAndColumns(self::fixture($name)));
                self::check($e?->code_ === Code::SCHEMA_DIFFERS, "$name: " . ($e?->getMessage() ?? 'no error'));
            }
            $added = $db->utils()->schema()->addTablesAndColumns(self::fixture('v2'));
            self::check($added === self::ADDED, 'addTablesAndColumns after the differences = ' . json_encode($added));
        } finally {
            $db->close();
        }
    }

    /**
     * 있는 table에 빠진 index는 더하고 다시 부르면 아무것도 하지 않는다. 빠진 unique key는 있는
     * 행에서 실패할 수 있으므로 그 이유를 적은 SCHEMA_DIFFERS다.
     */
    private static function addTablesAndColumnsIndex(string $dsn, string $driver): void
    {
        $db = self::installed($dsn);
        try {
            $unique = self::thrown(fn() => $db->utils()->schema()->addTablesAndColumns(self::fixture('unique')));
            self::check($unique?->code_ === Code::SCHEMA_DIFFERS && str_contains($unique->getMessage(), self::MISSING_UNIQUE), 'a missing unique key: ' . ($unique?->getMessage() ?? 'no error'));
            $added = $db->utils()->schema()->addTablesAndColumns(self::fixture('index'));
            self::check($added === self::ADDED_INDEX, 'addTablesAndColumns with a missing index = ' . json_encode($added));
            $again = $db->utils()->schema()->addTablesAndColumns(self::fixture('index'));
            self::check($again === [], 'repeated addTablesAndColumns with the index = ' . json_encode($again));
            // install은 database가 set과 같을 때만 아무것도 바꾸지 않는다: index가 선언대로 있다.
            $install = self::thrown(fn() => $db->utils()->schema()->install(self::fixture('index')));
            self::check($install === null, 'install of the set with the index: ' . ($install?->getMessage() ?? ''));
        } finally {
            $db->close();
        }
    }

    private static function addTablesAndColumnsTransaction(string $dsn, string $driver): void
    {
        $db = self::installed($dsn);
        try {
            if ($driver === 'postgres') {
                $rolledBack = false;
                try {
                    $db->transaction(function () use ($db): void {
                        $added = $db->utils()->schema()->addTablesAndColumns(self::fixture('v2'));
                        self::check($added === self::ADDED, 'addTablesAndColumns in the transaction = ' . json_encode($added));
                        throw new LogicException('roll back');
                    }, retry: 0);
                } catch (LogicException $e) {
                    $rolledBack = $e->getMessage() === 'roll back';
                }
                self::check($rolledBack, 'the transaction did not roll back');
            } else {
                $inside = null;
                $db->transaction(function () use ($db, &$inside): void {
                    $inside = self::thrown(fn() => $db->utils()->schema()->addTablesAndColumns(self::fixture('v2')));
                }, retry: 0);
                self::check($inside?->code_ === Code::CONFIG, "addTablesAndColumns in a $driver transaction: " . ($inside?->getMessage() ?? 'no error'));
            }
            $added = $db->utils()->schema()->addTablesAndColumns(self::fixture('v2'));
            self::check($added === self::ADDED, 'addTablesAndColumns after the transaction = ' . json_encode($added));
        } finally {
            $db->close();
        }
    }

    private static function addTablesAndColumnsEditedManifest(string $dsn, string $driver): void
    {
        $db = self::installed($dsn);
        try {
            $v2 = self::fixture('v2');
            $edited = new Schema(str_replace(' note ', ' memo ', $v2->manifestText), $v2->manifestHash);
            $e = self::thrown(fn() => $db->utils()->schema()->addTablesAndColumns($edited));
            self::check($e?->code_ === Code::CONFIG, 'addTablesAndColumns of an edited manifest: ' . ($e?->getMessage() ?? 'no error'));
            $added = $db->utils()->schema()->addTablesAndColumns($v2);
            self::check($added === self::ADDED, 'addTablesAndColumns after the edited manifest = ' . json_encode($added));
        } finally {
            $db->close();
        }
    }

    /** @return iterable<string, array{string}> the drivers of the case, each a data set */
    public static function drivers(): iterable
    {
        foreach (['sqlite', 'mysql', 'postgres'] as $driver) {
            yield $driver => [$driver];
        }
    }

    #[DataProvider('drivers')]
    public function test_add_tables_and_columns(string $driver): void
    {
        // The case installs its documents in a case database of its own, removed when it ends, also when it fails.
        with_case_database($driver, static function (string $step): void {}, static fn(string $dsn) => self::addTablesAndColumns($dsn, $driver));
    }

    #[DataProvider('drivers')]
    public function test_add_tables_and_columns_differs(string $driver): void
    {
        // The case installs its documents in a case database of its own, removed when it ends, also when it fails.
        with_case_database($driver, static function (string $step): void {}, static fn(string $dsn) => self::addTablesAndColumnsDiffers($dsn, $driver));
    }

    #[DataProvider('drivers')]
    public function test_add_tables_and_columns_index(string $driver): void
    {
        // The case installs its documents in a case database of its own, removed when it ends, also when it fails.
        with_case_database($driver, static function (string $step): void {}, static fn(string $dsn) => self::addTablesAndColumnsIndex($dsn, $driver));
    }

    #[DataProvider('drivers')]
    public function test_add_tables_and_columns_transaction(string $driver): void
    {
        // The case installs its documents in a case database of its own, removed when it ends, also when it fails.
        with_case_database($driver, static function (string $step): void {}, static fn(string $dsn) => self::addTablesAndColumnsTransaction($dsn, $driver));
    }

    #[DataProvider('drivers')]
    public function test_add_tables_and_columns_edited_manifest(string $driver): void
    {
        // The case installs its documents in a case database of its own, removed when it ends, also when it fails.
        with_case_database($driver, static function (string $step): void {}, static fn(string $dsn) => self::addTablesAndColumnsEditedManifest($dsn, $driver));
    }
}
