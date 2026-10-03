<?php
// addColumns를 SQLite, MySQL, PostgreSQL에서 확인한다(docs/schema.md "Adding columns"). case
// database는 다른 set addcol_log의 table과 addcol set version 1의 table을 row와 함께 가진다.
// version 2로 addColumns를 부르면 있는 table에 빠진 null이거나 default가 있는 column을 더하고,
// row를 지키며, 바뀐 audit table의 trigger가 새 column을 기록하고, 없는 table을 만들지 않으며,
// 다른 set의 table은 그대로 둔다. 다시 부르면 아무것도 더하지 않는다. 다른 차이가 있는 set은
// 아무것도 바꾸기 전에 SCHEMA_DIFFERS다. fixture는 contracts/fixtures/add_columns/*.dbs다. 각
// case는 자기 case database(case_database.php)에서 실행하며 ORM_TEST_MYSQL_DSN이나
// ORM_TEST_POSTGRES_DSN이 없으면 실패한다.
// Usage: php clients/php/tests/add_columns_test.php [case ...]
declare(strict_types=1);

require __DIR__ . '/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';
require_once __DIR__ . '/case_database.php';

use Orm\Code;
use Orm\Config;
use Orm\Db;
use Orm\Dbspec\Dbspec;
use Orm\Orm;
use Orm\OrmException;
use Orm\RuntimeModel;
use Orm\Schema;

// CASE_DEADLINE_SECONDS는 case 하나의 기한이다. case 하나는 database를 만들고 set 두 개를 설치하고
// column을 몇 번 더한 뒤 지운다.
const CASE_DEADLINE_SECONDS = 60;

const ADDED = [
    'addcol_item.note', 'addcol_item.priority', 'addcol_item.archived', 'addcol_item.status',
    'addcol_item_history.note', 'addcol_item_history.priority', 'addcol_item_history.archived', 'addcol_item_history.status',
    'addcol_tag.color',
];
const DIFFERS = ['required', 'removed', 'changed', 'nullable', 'default', 'index', 'unique', 'reorder'];

$failures = 0;
$current = '';
function check(bool $ok, string $message): void
{
    global $failures, $current;
    if (!$ok) {
        $failures++;
        fwrite(STDERR, "FAIL $current: $message\n");
    }
}

/** call이 던진 OrmException이다. 오류가 없으면 null이다. */
function thrown(callable $f): ?OrmException
{
    try {
        $f();
    } catch (OrmException $e) {
        return $e;
    }
    return null;
}

/** contracts/fixtures/add_columns/$name.dbs의 schema 값이다. */
function fixture(string $name): Schema
{
    $path = dirname(__DIR__, 3) . "/contracts/fixtures/add_columns/$name.dbs";
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
function count_of(Db $db, string $sql): int
{
    return (int) $db->pdo()->query($sql)->fetchColumn();
}

/**
 * case database에 addcol_log와 version 1을 설치하고 log row 하나, operation 1로 item 하나, 그
 * item의 tag와 그 tag의 자식 tag를 쓴 연결이다.
 */
function installed(string $dsn): Db
{
    $db = Orm::connect($dsn, new Config());
    $db->utils()->schema()->install(fixture('log'));
    $db->utils()->schema()->install(fixture('v1'));
    $pdo = $db->pdo();
    $pdo->exec("INSERT INTO addcol_log_entry (message) VALUES ('kept')");
    $pdo->exec("INSERT INTO addcol_item (ref, label, created_at, operation_id) VALUES ('item-1', 'first', '2026-01-01 00:00:00.000000', 1)");
    $pdo->exec("INSERT INTO addcol_tag (item_id, name) VALUES (1, 'red')");
    $pdo->exec("INSERT INTO addcol_tag (item_id, parent_id, name) VALUES (1, 1, 'child')");
    return $db;
}

function addColumns(string $dsn, string $driver): void
{
    $db = installed($dsn);
    try {
        $added = $db->utils()->schema()->addColumns(fixture('v2'));
        check($added === ADDED, 'addColumns = ' . json_encode($added));
        // row는 그대로이고 새 column은 NULL이거나 default다.
        $items = count_of($db, "SELECT COUNT(*) FROM addcol_item WHERE ref = 'item-1' AND label = 'first' AND note IS NULL AND priority = 3 AND archived = false AND status = 'new'");
        check($items === 1, "items with their values and the new defaults $items");
        check(count_of($db, 'SELECT COUNT(*) FROM addcol_tag WHERE color IS NULL') === 2, 'tags with a null color');
        check(count_of($db, "SELECT COUNT(*) FROM addcol_log_entry WHERE message = 'kept'") === 1, 'log entries');
        // SQLite는 foreign key를 끄고 table을 다시 만들었다. 연결이 다시 켰는지 본다.
        $orphan = null;
        try {
            $db->pdo()->exec("INSERT INTO addcol_tag (item_id, name) VALUES (999, 'orphan')");
        } catch (PDOException $e) {
            $orphan = $e;
        }
        check($orphan !== null, 'a tag of a missing item was written');
        // audit trigger는 새 column을 기록한다.
        $db->pdo()->exec("UPDATE addcol_item SET note = 'later', priority = 4, operation_id = 2 WHERE id = 1");
        $history = count_of($db, "SELECT COUNT(*) FROM addcol_item_history WHERE history_action = 'update' AND previous_operation_id = 1 AND operation_id = 2 AND note = 'later' AND priority = 4 AND status = 'new'");
        check($history === 1, "history rows of the update with the new columns $history");
        $extra = null;
        try {
            $db->pdo()->query('SELECT COUNT(*) FROM addcol_extra');
        } catch (PDOException $e) {
            $extra = $e;
        }
        check($extra !== null, 'addColumns created the missing table addcol_extra');
        $again = $db->utils()->schema()->addColumns(fixture('v2'));
        check($again === [], 'repeated addColumns = ' . json_encode($again));
        // install은 set을 통째로만 만든다(docs/schema.md "Schema installation").
        $install = thrown(fn() => $db->utils()->schema()->install(fixture('v2')));
        check($install?->code_ === Code::CONFIG, 'install of version 2 over its existing tables: ' . ($install?->getMessage() ?? 'no error'));
    } finally {
        $db->close();
    }
}

function addColumnsDiffers(string $dsn, string $driver): void
{
    $db = installed($dsn);
    try {
        foreach (DIFFERS as $name) {
            $e = thrown(fn() => $db->utils()->schema()->addColumns(fixture($name)));
            check($e?->code_ === Code::SCHEMA_DIFFERS, "$name: " . ($e?->getMessage() ?? 'no error'));
        }
        $added = $db->utils()->schema()->addColumns(fixture('v2'));
        check($added === ADDED, 'addColumns after the differences = ' . json_encode($added));
    } finally {
        $db->close();
    }
}

function addColumnsTransaction(string $dsn, string $driver): void
{
    $db = installed($dsn);
    try {
        if ($driver === 'postgres') {
            $rolledBack = false;
            try {
                $db->transaction(function () use ($db): void {
                    $added = $db->utils()->schema()->addColumns(fixture('v2'));
                    check($added === ADDED, 'addColumns in the transaction = ' . json_encode($added));
                    throw new LogicException('roll back');
                }, retry: 0);
            } catch (LogicException $e) {
                $rolledBack = $e->getMessage() === 'roll back';
            }
            check($rolledBack, 'the transaction did not roll back');
        } else {
            $inside = null;
            $db->transaction(function () use ($db, &$inside): void {
                $inside = thrown(fn() => $db->utils()->schema()->addColumns(fixture('v2')));
            }, retry: 0);
            check($inside?->code_ === Code::CONFIG, "addColumns in a $driver transaction: " . ($inside?->getMessage() ?? 'no error'));
        }
        $added = $db->utils()->schema()->addColumns(fixture('v2'));
        check($added === ADDED, 'addColumns after the transaction = ' . json_encode($added));
    } finally {
        $db->close();
    }
}

function addColumnsEditedManifest(string $dsn, string $driver): void
{
    $db = installed($dsn);
    try {
        $v2 = fixture('v2');
        $edited = new Schema(str_replace(' note ', ' memo ', $v2->manifestText), $v2->manifestHash);
        $e = thrown(fn() => $db->utils()->schema()->addColumns($edited));
        check($e?->code_ === Code::CONFIG, 'addColumns of an edited manifest: ' . ($e?->getMessage() ?? 'no error'));
        $added = $db->utils()->schema()->addColumns($v2);
        check($added === ADDED, 'addColumns after the edited manifest = ' . json_encode($added));
    } finally {
        $db->close();
    }
}

$cases = [
    'add_columns' => addColumns(...),
    'add_columns_differs' => addColumnsDiffers(...),
    'add_columns_transaction' => addColumnsTransaction(...),
    'add_columns_edited_manifest' => addColumnsEditedManifest(...),
];
$selected = array_slice($argv, 1) ?: array_keys($cases);
foreach ($selected as $case) {
    if (!isset($cases[$case])) {
        throw new RuntimeException("unknown case $case");
    }
    foreach (['sqlite', 'mysql', 'postgres'] as $driver) {
        $before = $failures;
        $current = "$case/$driver";
        $passed = testcase_run("add_columns/$current", CASE_DEADLINE_SECONDS, static function (callable $step) use ($cases, $case, $driver, $before): void {
            with_case_database($driver, $step, static fn(string $dsn) => $cases[$case]($dsn, $driver));
            if ($GLOBALS['failures'] > $before) {
                throw new RuntimeException(($GLOBALS['failures'] - $before) . ' check(s) failed; each FAIL line above names one');
            }
        });
        if (!$passed && $failures === $before) {
            $failures++;
        }
    }
}
if ($failures > 0) {
    exit(1);
}
