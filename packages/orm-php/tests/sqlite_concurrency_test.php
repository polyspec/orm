<?php
// SQLite locking: several processes commit read-then-write transactions on one file without
// transaction retries, a second connection reads while a write transaction is open, and a write
// that waits longer than busy_timeout returns CANCELED.
// Usage: php packages/orm-php/tests/sqlite_concurrency_test.php
// The test starts itself as a writer process: sqlite_concurrency_test.php writer <dsn> <name> <count>
declare(strict_types=1);

require __DIR__ . '/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';

use Polyspec\Orm\Tests\Model\Service;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\OrmException;

$documents = [(string) file_get_contents(dirname(__DIR__, 3) . '/schema/bench.dbs')];

function connect(string $dsn): Db
{
    return \Polyspec\Orm\Tests\Model\connect($dsn, new Config());
}

/** Runs $count transactions that read the service count and then insert one service. */
function writeServices(Db $db, string $name, int $count): void
{
    for ($i = 0; $i < $count; $i++) {
        $db->transaction(function () use ($name, $i): void {
            (new Service)->getCount();
            (new Service)->setName("$name-$i")->create();
        }, retry: 0);
    }
}

if (($argv[1] ?? '') === 'writer') {
    try {
        writeServices(connect($argv[2]), $argv[3], (int) $argv[4]);
    } catch (\Throwable $e) {
        fwrite(STDERR, get_class($e) . ': ' . $e->getMessage() . "\n");
        exit(1);
    }
    exit(0);
}

$failures = 0;
function check(bool $ok, string $message): void
{
    global $failures, $current;
    if (!$ok) {
        $failures++;
        fwrite(STDERR, "FAIL $current: $message\n");
    }
}

$work = sys_get_temp_dir() . '/orm-php-sqlite-lock-' . getmypid();
@mkdir($work, 0o700, true);
register_shutdown_function(static function () use ($work): void {
    foreach (glob("$work/*") ?: [] as $file) {
        @unlink($file);
    }
    @rmdir($work);
});

/** A new SQLite file with the schema installed and its DSN. */
function database(string $name): string
{
    global $documents, $work;
    $dsn = "sqlite://$work/$name.sqlite";
    connect($dsn)->utils()->schema()->install(\Polyspec\Orm\Tests\Model\schema());
    return $dsn;
}

$tests = [];

$tests['writers in several processes'] = function (): void {
    $dsn = database('processes');
    $children = [];
    for ($i = 0; $i < 6; $i++) {
        $p = proc_open([PHP_BINARY, __FILE__, 'writer', $dsn, "p$i", '40'], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        $children[] = [$p, $pipes];
    }
    foreach ($children as $i => [$p, $pipes]) {
        $out = stream_get_contents($pipes[1]) . stream_get_contents($pipes[2]);
        $status = proc_close($p);
        check($status === 0, "writer process $i exited with $status: $out");
    }
    $count = (new Service)(connect($dsn))->getCount();
    check($count === 240, "services: $count, want 240");
};

$tests['reads during a write'] = function (): void {
    $dsn = database('reads');
    $writer = connect($dsn);
    $reader = connect($dsn);
    $writer->transaction(function () use ($reader): void {
        (new Service)->setName('pending')->create();
        $count = (new Service)($reader)->getCount();
        check($count === 0, "read during the write: $count services, want 0");
        $count = $reader->transaction(fn() => (new Service)->getCount(), readOnly: true, retry: 0);
        check($count === 0, "read-only transaction during the write: $count services, want 0");
    }, retry: 0);
    $count = (new Service)($reader)->getCount();
    check($count === 1, "read after the write: $count services, want 1");
};

$tests['lock wait expires'] = function (): void {
    $dsn = database('expiry');
    $holder = connect($dsn);
    $waiter = connect("$dsn?_pragma=busy_timeout(200)");
    $holder->transaction(function () use ($waiter): void {
        (new Service)->setName('holder')->create();
        $started = microtime(true);
        $code = 'no error';
        try {
            writeServices($waiter, 'waiter', 1);
        } catch (OrmException $e) {
            $code = $e->code_;
        }
        $waited = microtime(true) - $started;
        check($code === Code::CANCELED, "write past the lock wait: $code, want CANCELED");
        check($waited >= 0.2, sprintf('write returned after %.3fs, before the 200ms lock wait', $waited));
    }, retry: 0);
};

// 각 case의 기한은 TESTCASE_PROCESS다. 가장 큰 case가 writer process 여러 개를 띄워
// transaction을 commit한다.
foreach ($tests as $name => $test) {
    $current = $name;
    $before = $failures;
    $passed = testcase_run("sqlite_concurrency/$name", TESTCASE_PROCESS, static function () use ($test, $before): void {
        $test();
        if ($GLOBALS['failures'] > $before) {
            throw new RuntimeException(($GLOBALS['failures'] - $before) . ' check(s) failed; each FAIL line above names one');
        }
    });
    if (!$passed && $failures === $before) {
        $failures++;
    }
}
if ($failures > 0) {
    exit(1);
}
