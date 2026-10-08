<?php
declare(strict_types=1);
// Runtime model behavior on SQLite, MySQL and PostgreSQL (docs/dbspec.md
// "Runtime model" and "Audit"): installing a dbspec document set, i16, uuid,
// date and time values, database defaults for omitted columns, the required
// column rule, the audit record of a transaction, and the restore of
// soft-deleted rows. The models of contracts/fixtures/audit.dbs with a values
// document and of contracts/fixtures/restore.dbs are generated into a temporary
// directory as two document sets, because both fixtures declare the table audit,
// so the test runs in its own process.
// Each case runs in a case database of its own (case_database.php) created
// through ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN; the test fails when either
// is unset.
// Usage: php packages/orm-php/tests/runtime_db_test.php

// bench model은 읽지 않는다: 이 test는 자기 document set의 model만 쓴다.
require dirname(__DIR__, 3) . '/vendor-php/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';
require_once __DIR__ . '/case_database.php';
require_once __DIR__ . '/restore_case.php';
require_once __DIR__ . '/audit_case.php';

use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Generator;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Tests\RuntimeDb\Item;
use Polyspec\Orm\Tests\RuntimeDb\Sample;

$root = dirname(__DIR__, 3);
$work = sys_get_temp_dir() . '/orm-php-runtime-db-' . getmypid();
@mkdir($work, 0o700, true);
register_shutdown_function(static function () use ($work): void {
    exec('rm -rf ' . escapeshellarg($work));
});

$values = "dbspec 1 runtime_values\n\ntable sample {\n  seq i64 identity\n  level i16\n  amount i32 default 7\n  label varchar(16) default 'x'\n"
    . "  note text null\n  day date null\n  clock time(3) null\n  created datetime(6) default now\n  token uuid null\n  primary key (seq)\n}\n";
// audit.dbs와 restore.dbs는 둘 다 audit table을 선언하므로 따로 생성하고 case마다 하나만 설치한다.
$sets = [
    'Polyspec\\Orm\\Tests\\RuntimeDb' => ['audit.dbs' => (string) file_get_contents("$root/contracts/fixtures/audit.dbs"), 'values.dbs' => $values],
    'Polyspec\\Orm\\Tests\\RuntimeRestore' => ['restore.dbs' => (string) file_get_contents("$root/contracts/fixtures/restore.dbs")],
];
foreach ($sets as $namespace => $texts) {
    $dir = "$work/" . str_replace('\\', '_', $namespace);
    Generator::generate(RuntimeModel::build(RuntimeModel::parse($texts)), $dir, $namespace);
    spl_autoload_register(static function (string $class) use ($dir, $namespace): void {
        if (str_starts_with($class, "$namespace\\")) {
            require "$dir/" . substr($class, strlen("$namespace\\")) . '.php';
        }
    });
    require "$dir/bootstrap.php";
}

function want(bool $ok, string $message): void
{
    if (!$ok) {
        throw new RuntimeException($message);
    }
}

function errorCode(Closure $fn): string
{
    try {
        $fn();
    } catch (OrmException $e) {
        return $e->code_;
    }
    return 'no error';
}

/** actor 'default'를 audit 값으로 주는 audit source로 dsn에 연결하고 $namespace의 document set을 설치한다. */
function database(string $dsn, string $namespace): Db
{
    $db = Orm::connect($dsn, auditConfig('default'));
    $db->utils()->schema()->install(("$namespace\\schema")());
    return $db;
}

$cases = [];

$cases['install renders the document set'] = function (Db $db): void {
    $count = static fn(string $table): int => (int) $db->pdo()->query("SELECT COUNT(*) FROM $table")->fetchColumn();
    want($count('item') === 0 && $count('item_history') === 0 && $count('sample') === 0, 'installed tables');
    $db->utils()->schema()->install(\Polyspec\Orm\Tests\RuntimeDb\schema());
    want($count('sample') === 0, 'a repeated install');
};

$cases['i16 values and defaults'] = function (Db $db): void {
    $low = (new Sample)($db)->setLevel(-32768)->create();
    $high = (new Sample)($db)->setLevel(32767)->setNote('n')->setToken('0f8fad5b-d9cb-469f-a165-70867728950e')
        ->setDay(new DateTimeImmutable('2026-02-03'))->setClock('12:34:56.789')->create();
    $row = (new Sample)($db)->getBySeq($low->getSeq());
    want($row->getLevel() === -32768, 'i16 low ' . var_export($row->getLevel(), true));
    want($row->getAmount() === 7 && $row->getLabel() === 'x', 'database defaults');
    want(abs($row->getCreated()->getTimestamp() - time()) < 60 && $row->getCreated()->getOffset() === 0, 'now default in UTC');
    want($row->getNote() === null && $row->getToken() === null, 'null columns');
    $row = (new Sample)($db)->getBySeq($high->getSeq());
    want($row->getLevel() === 32767 && $row->getToken() === '0f8fad5b-d9cb-469f-a165-70867728950e', 'i16 high and uuid');
    want($row->getDay()->format('Y-m-d') === '2026-02-03' && $row->getClock() === '12:34:56.789', 'date and time');
    want((new Sample)($db)->level(32767)->getCount() === 1 && (new Sample)($db)->ltLevel(0)->getCount() === 1, 'i16 conditions');
    want((new Sample)($db)->token('0f8fad5b-d9cb-469f-a165-70867728950e')->getCount() === 1, 'uuid condition');
    want(errorCode(fn() => (new Sample)($db)->setAmount(1)->create()) === Code::IR_INVALID, 'an omitted non-null column without a default');
    want((new Sample)($db)->getCount() === 2, 'the rejected insert stays out of the database');
};

// audit transaction은 audit 기록 하나를 삽입하고 audit table의 write가 그 key를 쓴다(audit_case.php).
$cases['audit record of a transaction'] = function (Db $db, string $dsn): void {
    auditCase($db, $dsn, 'Polyspec\\Orm\\Tests\\RuntimeDb');
    $assigned = errorCode(fn() => $db->transaction(fn() => (new Item)->setTitle('a')->setAuditSeq(1)->create(), audit: [], retry: 0));
    want($assigned === Code::IR_INVALID, "an assigned audit column = $assigned, want IR_INVALID");
    want((new Item)($db)->getCount() === 0, 'soft delete hides the row');
};

// restore는 soft delete한 행을 primary key나 unique key로 되돌린다(restore_case.php).
$cases['restore of soft-deleted rows'] = function (Db $db): void {
    restoreCase($db, 'Polyspec\\Orm\\Tests\\RuntimeRestore');
};

$failures = 0;
// 각 case는 자기 case database에 문서 집합을 설치하고 row 몇 개를 쓰고 읽은 뒤 database를 지운다.
foreach (['sqlite', 'mysql', 'postgres'] as $driver) {
    foreach ($cases as $name => $case) {
        $passed = testcase_run("runtime_db/$name/$driver", TESTCASE_DATABASE, static function (callable $step) use ($driver, $name, $case): void {
            with_case_database($driver, $step, static function (string $dsn) use ($name, $case): void {
                $db = database($dsn, $name === 'restore of soft-deleted rows' ? 'Polyspec\\Orm\\Tests\\RuntimeRestore' : 'Polyspec\\Orm\\Tests\\RuntimeDb');
                try {
                    $case($db, $dsn);
                } finally {
                    $db->close();
                }
            });
        });
        if (!$passed) {
            $failures++;
        }
    }
}
if ($failures > 0) {
    exit(1);
}
