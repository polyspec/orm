<?php
declare(strict_types=1);
// Runtime model behavior on SQLite, MySQL and PostgreSQL (docs/dbspec.md
// "Runtime model" and "Audit"): installing a dbspec document set, i16, uuid,
// date and time values, database defaults for omitted columns, the required
// column rule, and the audit operation id. The models of
// contracts/fixtures/audit.dbs and a values document are generated into a
// temporary directory, so the test runs in its own process.
// ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN name empty test databases; the
// test fails when either is unset.
// Usage: php clients/php/tests/runtime_db_test.php

// bench model은 읽지 않는다: 이 test는 자기 document set의 model만 쓴다.
require dirname(__DIR__) . '/vendor/autoload.php';

use Orm\Code;
use Orm\Config;
use Orm\Db;
use Orm\Generator;
use Orm\Orm;
use Orm\OrmException;
use Orm\RuntimeModel;
use RuntimeDb\Orm\Item;
use RuntimeDb\Orm\ItemHistory;
use RuntimeDb\Orm\Sample;

$started = hrtime(true);
echo "RUN runtime_db\n";
$root = dirname(__DIR__, 3);
$work = sys_get_temp_dir() . '/orm-php-runtime-db-' . getmypid();
@mkdir($work, 0o700, true);
register_shutdown_function(static function () use ($work): void {
    exec('rm -rf ' . escapeshellarg($work));
});

$values = "dbspec 1 runtime_values\n\ntable sample {\n  seq i64 identity\n  level i16\n  amount i32 default 7\n  label varchar(16) default 'x'\n"
    . "  note text null\n  day date null\n  clock time(3) null\n  created datetime(6) default now\n  token uuid null\n  primary key (seq)\n}\n";
$documents = [(string) file_get_contents("$root/contracts/fixtures/audit.dbs"), $values];
Generator::generate(RuntimeModel::build(RuntimeModel::parse(['audit.dbs' => $documents[0], 'values.dbs' => $values])), "$work/gen", 'RuntimeDb\\Orm');
spl_autoload_register(static function (string $class) use ($work): void {
    if (str_starts_with($class, 'RuntimeDb\\Orm\\')) {
        require "$work/gen/" . substr($class, strlen('RuntimeDb\\Orm\\')) . '.php';
    }
});
require "$work/gen/bootstrap.php";

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

/** 이 test가 설치하는 table과 PostgreSQL trigger function을 지운다. */
function dropAll(string $driver, string $dsn): void
{
    [, $pdoDsn, $user, $password] = Orm::parseDsn($dsn);
    $raw = new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    foreach (['item', 'item_history', 'sample'] as $table) {
        $raw->exec($driver === 'postgres' ? "DROP TABLE IF EXISTS \"$table\" CASCADE" : ($driver === 'mysql' ? "DROP TABLE IF EXISTS `$table`" : "DROP TABLE IF EXISTS \"$table\""));
    }
    if ($driver === 'postgres') {
        // PostgreSQL trigger function은 table과 함께 지워지지 않는다.
        foreach (['insert', 'update', 'delete'] as $event) {
            $raw->exec("DROP FUNCTION IF EXISTS \"item\$audit_$event\"()");
        }
    }
}

function database(string $driver, string $dsn): Db
{
    global $documents;
    dropAll($driver, $dsn);
    $db = Orm::connect($dsn, new Config());
    $db->utils()->schema()->install(\RuntimeDb\Orm\schema());
    return $db;
}

$cases = [];

$cases['install renders the document set'] = function (Db $db): void {
    global $documents;
    $count = static fn(string $table): int => (int) $db->pdo()->query("SELECT COUNT(*) FROM $table")->fetchColumn();
    want($count('item') === 0 && $count('item_history') === 0 && $count('sample') === 0, 'installed tables');
    $db->utils()->schema()->install(\RuntimeDb\Orm\schema());
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

$cases['audit operation id'] = function (Db $db): void {
    want(errorCode(fn() => (new Item)($db)->setTitle('a')->create()) === Code::CONFIG, 'an audited insert without an operation id');
    want(errorCode(fn() => $db->transaction(fn() => (new Item)->setTitle('a')->create(), retry: 0)) === Code::CONFIG, 'a transaction without an operation id');
    want(errorCode(fn() => $db->transaction(fn() => (new Item)->setTitle('a')->create(), operation: 'x', retry: 0)) === Code::CONFIG, 'an operation id of another type');
    want(errorCode(fn() => $db->transaction(fn() => (new Item)->setTitle('a')->setOperationId(9)->create(), operation: 41, retry: 0)) === Code::IR_INVALID, 'an assigned operation column');
    $item = $db->transaction(fn() => (new Item)->setTitle('first')->create(), operation: 41, retry: 0);
    $db->transaction(fn() => (new Item)->getBySeq($item->getSeq())->setTitle('second')->update(), operation: 42, retry: 0);
    $db->transaction(function () use ($item): void {
        (new Item)->getBySeq($item->getSeq())->delete();
    }, operation: 43, retry: 0);
    want((new Item)($db)->getCount() === 0, 'soft delete hides the row');
    $history = [];
    foreach ((new ItemHistory)($db)->orderByHistoryIdAsc()->gets() as $h) {
        $history[] = [$h->getChange(), $h->getPreviousOperationId(), $h->getOperationId(), $h->getTitle(), $h->getDeletedAt() !== null];
    }
    $expected = [['insert', null, 41, 'first', false], ['update', 41, 42, 'second', false], ['update', 42, 43, 'second', true]];
    want($history === $expected, 'history ' . json_encode($history));
    $count = (int) $db->pdo()->query('SELECT COUNT(*) FROM item')->fetchColumn();
    want($count === 1, "stored rows $count");
};

$targets = ['sqlite' => "sqlite://$work/runtime.sqlite"];
foreach (['mysql' => 'ORM_TEST_MYSQL_DSN', 'postgres' => 'ORM_TEST_POSTGRES_DSN'] as $driver => $env) {
    $v = getenv($env);
    if ($v === false || $v === '') {
        throw new RuntimeException("$env is required; database tests never skip");
    }
    $targets[$driver] = $v;
}
$failures = 0;
foreach ($targets as $driver => $dsn) {
    foreach ($cases as $name => $case) {
        $t = hrtime(true);
        echo "RUN $name/$driver\n";
        try {
            $db = database($driver, $dsn);
            $case($db);
            $db->close();
            dropAll($driver, $dsn);
            echo "PASS $name/$driver elapsedMs=" . ((hrtime(true) - $t) / 1e6) . "\n";
        } catch (Throwable $e) {
            $failures++;
            echo "FAIL $name/$driver elapsedMs=" . ((hrtime(true) - $t) / 1e6) . "\n";
            fwrite(STDERR, "FAIL $name/$driver: " . get_class($e) . ': ' . $e->getMessage() . "\n");
        }
    }
}
$elapsed = (hrtime(true) - $started) / 1e6;
if ($elapsed > 120000) {
    fwrite(STDERR, "runtime_db deadline of 120 s exceeded ($elapsed ms)\n");
    exit(1);
}
if ($failures > 0) {
    echo "FAIL runtime_db failures=$failures elapsedMs=$elapsed\n";
    exit(1);
}
echo "PASS runtime_db databases=" . count($targets) . " elapsedMs=$elapsed\n";
