<?php
declare(strict_types=1);
// SQLite locking: several processes commit read-then-write transactions on one file without
// transaction retries, a second connection reads while a write transaction is open, and a write
// that waits longer than busy_timeout returns CANCELED.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/SqliteConcurrencyTest.php [--filter <case>]
// The writer processes run sqlite_concurrency_writer.php <dsn> <name> <count>.

use Polyspec\Orm\Tests\Model\Service;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\OrmException;
use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;

#[Large]
final class SqliteConcurrencyTest extends TestCase
{
    private static mixed $documents = null;
    private static mixed $work = null;

    /** The fixture of the file: what the script did before its cases, once per class. */
    private static function fixture(): void
    {
        self::$documents = [(string) file_get_contents(dirname(__DIR__, 3) . '/contracts/fixtures/bench/bench.dbs')];

        self::$work = sys_get_temp_dir() . '/orm-php-sqlite-lock-' . getmypid();
        @mkdir(self::$work, 0o700, true);
        register_shutdown_function(static function (): void {
            foreach (glob(self::$work . "/*") ?: [] as $file) {
                @unlink($file);
            }
            @rmdir(self::$work);
        });
    }

    private static function connect(string $dsn): Db
    {
        return \Polyspec\Orm\Tests\Model\connect($dsn, new Config());
    }

    /** Runs $count transactions that read the service count and then insert one service. */
    private static function writeServices(Db $db, string $name, int $count): void
    {
        for ($i = 0; $i < $count; $i++) {
            $db->transaction(function () use ($name, $i): void {
                (new Service)->getCount();
                (new Service)->setName("$name-$i")->create();
            }, retry: 0);
        }
    }

    private static function check(bool $ok, string $message): void
    {
        \PHPUnit\Framework\Assert::assertTrue($ok, $message);
    }

    /** A new SQLite file with the schema installed and its DSN. */
    private static function database(string $name): string
    {
        $dsn = "sqlite://" . self::$work . "/$name.sqlite";
        \Polyspec\Orm\Tests\installBench(self::connect($dsn));
        return $dsn;
    }

    private static function case_writers_in_several_processes(): void {
        $dsn = self::database('processes');
        $children = [];
        for ($i = 0; $i < 6; $i++) {
            $p = proc_open([PHP_BINARY, __DIR__ . '/sqlite_concurrency_writer.php', $dsn, "p$i", '40'], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
            $children[] = [$p, $pipes];
        }
        foreach ($children as $i => [$p, $pipes]) {
            $out = stream_get_contents($pipes[1]) . stream_get_contents($pipes[2]);
            $status = proc_close($p);
            self::check($status === 0, "writer process $i exited with $status: $out");
        }
        $count = (new Service)(self::connect($dsn))->getCount();
        self::check($count === 240, "services: $count, want 240");
    }

    private static function case_reads_during_a_write(): void {
        $dsn = self::database('reads');
        $writer = self::connect($dsn);
        $reader = self::connect($dsn);
        $writer->transaction(function () use ($reader): void {
            (new Service)->setName('pending')->create();
            $count = (new Service)($reader)->getCount();
            self::check($count === 0, "read during the write: $count services, want 0");
            $count = $reader->transaction(fn() => (new Service)->getCount(), readOnly: true, retry: 0);
            self::check($count === 0, "read-only transaction during the write: $count services, want 0");
        }, retry: 0);
        $count = (new Service)($reader)->getCount();
        self::check($count === 1, "read after the write: $count services, want 1");
    }

    private static function case_lock_wait_expires(): void {
        $dsn = self::database('expiry');
        $holder = self::connect($dsn);
        $waiter = self::connect("$dsn?_pragma=busy_timeout(200)");
        $holder->transaction(function () use ($waiter): void {
            (new Service)->setName('holder')->create();
            $started = microtime(true);
            $code = 'no error';
            try {
                self::writeServices($waiter, 'waiter', 1);
            } catch (OrmException $e) {
                $code = $e->code_;
            }
            $waited = microtime(true) - $started;
            self::check($code === Code::CANCELED, "write past the lock wait: $code, want CANCELED");
            self::check($waited >= 0.2, sprintf('write returned after %.3fs, before the 200ms lock wait', $waited));
        }, retry: 0);
    }

    public static function setUpBeforeClass(): void
    {
        self::fixture();
    }

    public function test_writers_in_several_processes(): void
    {
        self::case_writers_in_several_processes();
    }

    public function test_reads_during_a_write(): void
    {
        self::case_reads_during_a_write();
    }

    public function test_lock_wait_expires(): void
    {
        self::case_lock_wait_expires();
    }
}
