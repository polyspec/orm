<?php

declare(strict_types=1);

// Checks addTablesAndColumns on SQLite, MySQL, and PostgreSQL (docs/spec/schema.md "Adding tables and
// columns"). The case database holds the table of the other set addcol_log and the table of addcol set version 1,
// together with rows. Calling addTablesAndColumns with version 2 adds to existing tables the missing columns that are
// nullable or have a default, keeps the rows, the trigger of the changed audit table records the new column, and a
// missing table is created with its index, foreign key, check, and audit trigger, and the tables of other sets are
// left alone. Calling it again adds nothing. Missing indexes on existing tables are added, and a missing unique key
// is SCHEMA_DIFFERS, which states the reason. A set with another difference, before changing anything,
// is SCHEMA_DIFFERS. The fixtures are contracts/fixtures/add_tables_and_columns/*.dbs. Each case
// runs in its own case database (case_database.php), and ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN
// is missing, the test fails.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist
// packages/php/tests/AddTablesAndColumnsTest.php [--filter <case>]

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
        'addcol_item_history.note',
        'addcol_item_history.priority',
        'addcol_item_history.archived',
        'addcol_item_history.status',
        'addcol_tag.color',
    ];
    private const DIFFERS = ['required', 'removed', 'changed', 'nullable', 'default', 'unique', 'reorder'];
    // index.dbs adds the column and index for version 1. The index comes after the column.
    private const ADDED_INDEX = ['addcol_item.note', 'addcol_item.ix_addcol_item_label', 'addcol_item_history.note'];
    private const MISSING_UNIQUE = 'add_unique addcol_item.uq_addcol_item_label: a missing unique key can fail on '
        . 'the existing rows; add it with a plan';

    private static function check(bool $ok, string $message): void
    {
        \PHPUnit\Framework\Assert::assertTrue($ok, $message);
    }

    /** The OrmException thrown by the call. It is null if there was no error. */
    private static function thrown(callable $f): ?OrmException
    {
        try {
            $f();
        } catch (OrmException $e) {
            return $e;
        }
        return null;
    }

    /** The schema value of contracts/fixtures/add_tables_and_columns/$name.dbs. */
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

    /** Reads the count the query returns through the connection's PDO. */
    private static function rowCount(Db $db, string $sql): int
    {
        return (int) $db->pdo()->query($sql)->fetchColumn();
    }

    /**
     * Installs addcol_log and version 1 in the case database, one log row, one item with audit record 1, and the
     * link written with the item's tag and that tag's child tag. The item's audit column refers to the row of the audit
     * record table by a foreign key, so the audit record is written first.
     */
    private static function installed(string $dsn): Db
    {
        $db = Orm::connect($dsn, new Config());
        $db->utils()->schema()->install(self::fixture('log'));
        $db->utils()->schema()->install(self::fixture('v1'));
        $pdo = $db->pdo();
        $pdo->exec("INSERT INTO addcol_log_entry (message) VALUES ('kept')");
        $pdo->exec("INSERT INTO audit (actor) VALUES ('setup')");
        $pdo->exec(
            "INSERT INTO addcol_item (ref, label, created_at, audit_seq) VALUES ('item-1', 'first', '2026-01-01 "
            . "00:00:00.000000', 1)"
        );
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
            // The rows are unchanged, and the new columns are NULL or default.
            $items = self::rowCount(
                $db,
                "SELECT COUNT(*) FROM addcol_item WHERE ref = 'item-1' AND label = 'first' AND note IS NULL AND "
                . "priority = 3 AND archived = false AND status = 'new'"
            );
            self::check($items === 1, "items with their values and the new defaults $items");
            self::check(
                self::rowCount($db, 'SELECT COUNT(*) FROM addcol_tag WHERE color IS NULL') === 2,
                'tags with a null color'
            );
            self::check(
                self::rowCount($db, "SELECT COUNT(*) FROM addcol_log_entry WHERE message = 'kept'") === 1,
                'log entries'
            );
            // SQLite turns foreign keys off and recreates the table. Checks that the connection turned them back on.
            $orphan = null;
            try {
                $db->pdo()->exec("INSERT INTO addcol_tag (item_id, name) VALUES (999, 'orphan')");
            } catch (PDOException $e) {
                $orphan = $e;
            }
            self::check($orphan !== null, 'a tag of a missing item was written');
            // The audit trigger records the new column.
            $db->pdo()->exec("INSERT INTO audit (actor) VALUES ('update')");
            $db->pdo()->exec("UPDATE addcol_item SET note = 'later', priority = 4, audit_seq = 2 WHERE id = 1");
            $history = self::rowCount(
                $db,
                "SELECT COUNT(*) FROM addcol_item_history WHERE history_action = 'update' AND previous_audit_seq = 1 "
                . "AND audit_seq = 2 AND note = 'later' AND priority = 4 AND status = 'new'"
            );
            self::check($history === 1, "history rows of the update with the new columns $history");
            // The new table was created with its index, foreign key, check, and audit trigger.
            $db->pdo()->exec("INSERT INTO audit (actor) VALUES ('extra')");
            $db->pdo()->exec("INSERT INTO addcol_extra (item_id, label, audit_seq) VALUES (1, 'extra', 3)");
            $inserted = self::rowCount(
                $db,
                "SELECT COUNT(*) FROM addcol_extra_history WHERE history_action = 'insert' AND previous_audit_seq IS "
                . "NULL AND audit_seq = 3 AND item_id = 1 AND label = 'extra'"
            );
            self::check($inserted === 1, "history rows of the insert into the created table $inserted");
            foreach (
                [
                "INSERT INTO addcol_extra (item_id, label, audit_seq) VALUES (999, 'orphan', 3)" => 'foreign key',
                "INSERT INTO addcol_extra (item_id, label, audit_seq) VALUES (1, 'extra', 999)" => 'audit foreign key',
                "INSERT INTO addcol_extra (item_id, label, audit_seq) VALUES (1, '', 3)" => 'check',
                'DELETE FROM addcol_extra' => 'audit delete',
                ] as $statement => $what
            ) {
                $refused = null;
                try {
                    $db->pdo()->exec($statement);
                } catch (PDOException $e) {
                    $refused = $e;
                }
                self::check($refused !== null, "the $what of the created table accepted $statement");
            }
            self::check(self::rowCount($db, 'SELECT COUNT(*) FROM addcol_extra') === 1, 'rows of the created table');
            $again = $db->utils()->schema()->addTablesAndColumns(self::fixture('v2'));
            self::check($again === [], 'repeated addTablesAndColumns = ' . json_encode($again));
            // Every table exists, so install changes nothing (docs/spec/schema.md "Schema installation").
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
     * Adds the missing index to an existing table, and calling again does nothing. A missing unique key on a table that
     * has rows fails, so it is SCHEMA_DIFFERS stating the reason.
     */
    private static function addTablesAndColumnsIndex(string $dsn, string $driver): void
    {
        $db = self::installed($dsn);
        try {
            $unique = self::thrown(fn() => $db->utils()->schema()->addTablesAndColumns(self::fixture('unique')));
            self::check(
                $unique?->code_ === Code::SCHEMA_DIFFERS && str_contains($unique->getMessage(), self::MISSING_UNIQUE),
                'a missing unique key: ' . ($unique?->getMessage() ?? 'no error')
            );
            $added = $db->utils()->schema()->addTablesAndColumns(self::fixture('index'));
            self::check(
                $added === self::ADDED_INDEX,
                'addTablesAndColumns with a missing index = ' . json_encode($added)
            );
            $again = $db->utils()->schema()->addTablesAndColumns(self::fixture('index'));
            self::check($again === [], 'repeated addTablesAndColumns with the index = ' . json_encode($again));
            // install changes nothing only when the database matches the set: the index exists as declared.
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
                        self::check(
                            $added === self::ADDED,
                            'addTablesAndColumns in the transaction = ' . json_encode($added)
                        );
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
                self::check(
                    $inside?->code_ === Code::CONFIG,
                    "addTablesAndColumns in a $driver transaction: " . ($inside?->getMessage() ?? 'no error')
                );
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
            self::check(
                $e?->code_ === Code::CONFIG,
                'addTablesAndColumns of an edited manifest: ' . ($e?->getMessage() ?? 'no error')
            );
            $added = $db->utils()->schema()->addTablesAndColumns($v2);
            self::check(
                $added === self::ADDED,
                'addTablesAndColumns after the edited manifest = ' . json_encode($added)
            );
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

    // Requirements: SCH-8, SCH-10.
    #[DataProvider('drivers')]
    public function testAddTablesAndColumns(string $driver): void
    {
        // The case installs its documents in a case database of its own, removed when it ends, also when it fails.
        with_case_database($driver, static function (string $step): void {
        }, static fn(string $dsn) => self::addTablesAndColumns($dsn, $driver));
    }

    // Requirements: SCH-9.
    #[DataProvider('drivers')]
    public function testAddTablesAndColumnsDiffers(string $driver): void
    {
        // The case installs its documents in a case database of its own, removed when it ends, also when it fails.
        with_case_database($driver, static function (string $step): void {
        }, static fn(string $dsn) => self::addTablesAndColumnsDiffers($dsn, $driver));
    }

    // Requirements: SCH-8, SCH-9.
    #[DataProvider('drivers')]
    public function testAddTablesAndColumnsIndex(string $driver): void
    {
        // The case installs its documents in a case database of its own, removed when it ends, also when it fails.
        with_case_database($driver, static function (string $step): void {
        }, static fn(string $dsn) => self::addTablesAndColumnsIndex($dsn, $driver));
    }

    // Requirements: SCH-8.
    #[DataProvider('drivers')]
    public function testAddTablesAndColumnsTransaction(string $driver): void
    {
        // The case installs its documents in a case database of its own, removed when it ends, also when it fails.
        with_case_database($driver, static function (string $step): void {
        }, static fn(string $dsn) => self::addTablesAndColumnsTransaction($dsn, $driver));
    }

    // Requirements: SCH-8.
    #[DataProvider('drivers')]
    public function testAddTablesAndColumnsEditedManifest(string $driver): void
    {
        // The case installs its documents in a case database of its own, removed when it ends, also when it fails.
        with_case_database($driver, static function (string $step): void {
        }, static fn(string $dsn) => self::addTablesAndColumnsEditedManifest($dsn, $driver));
    }
}
