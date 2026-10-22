<?php

declare(strict_types=1);

// INT-52 wasInserted and INT-53 backendWaitingForLock on Polyspec\Orm\Utils, on SQLite, MySQL and PostgreSQL. The model
// is the clock fixture contracts/fixtures/clock.dbs, generated into a temporary directory under
// Polyspec\Orm\Tests\WasInsertedCase. Each case runs in a case database of its own (case_database.php); MySQL and
// PostgreSQL need ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN, and the test fails when either is unset.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/WasInsertedTest.php
// [--filter <case>]
require_once __DIR__ . '/case_database.php';
require_once __DIR__ . '/MarkdownTest.php';

use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Generator;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
final class WasInsertedTest extends TestCase
{
    private static bool $generated = false;

    /** Generates the clock fixture once per class and autoloads it under Polyspec\Orm\Tests\WasInsertedCase. */
    private static function fixture(): void
    {
        if (self::$generated) {
            return;
        }
        $work = sys_get_temp_dir() . '/orm-php-was-inserted-' . getmypid();
        @mkdir($work, 0o700, true);
        register_shutdown_function(static function () use ($work): void {
            exec('rm -rf ' . escapeshellarg($work));
        });
        $document = (string) file_get_contents(dirname(__DIR__, 3) . '/contracts/fixtures/clock.dbs');
        Generator::generate(
            RuntimeModel::build(RuntimeModel::parse(['clock.dbs' => $document])),
            "$work/models",
            'Polyspec\\Orm\\Tests\\WasInsertedCase'
        );
        spl_autoload_register(static function (string $class) use ($work): void {
            if (str_starts_with($class, 'Polyspec\\Orm\\Tests\\WasInsertedCase\\')) {
                require "$work/models/" . substr($class, strlen('Polyspec\\Orm\\Tests\\WasInsertedCase\\')) . '.php';
            }
        });
        require "$work/models/bootstrap.php";
        self::$generated = true;
    }

    /** @return iterable<string, array{string}> */
    public static function drivers(): iterable
    {
        yield 'sqlite' => ['sqlite'];
        yield 'mysql' => ['mysql'];
        yield 'postgres' => ['postgres'];
    }

    private static function connect(string $dsn): \Polyspec\Orm\Db
    {
        self::fixture();
        $db = Orm::connect($dsn . (str_contains($dsn, '?') ? '&' : '?') . 'timezone=%2B00:00', new Config());
        $db->utils()->schema()->install(\Polyspec\Orm\Tests\WasInsertedCase\schema());
        return $db;
    }

    /**
     * Runs the case on a new case database of $driver, which is dropped afterwards, with the connection and its DSN.
     */
    private static function onCase(string $driver, \Closure $body): void
    {
        with_case_database($driver, static function (string $step): void {
        }, static function (string $dsn) use ($body): void {
            $db = self::connect($dsn);
            try {
                $body($db, $dsn);
            } finally {
                $db->close();
            }
        });
    }

    /** The error code that $call raises, or 'none'. */
    private static function codeOf(\Closure $call): string
    {
        try {
            $call();
        } catch (OrmException $e) {
            return $e->code_;
        }
        return 'none';
    }

    /**
     * A generated insert inside a transaction is recorded for its key; an insert of another transaction is not. Nested
     * rollback removes its key only.
     */
    #[DataProvider('drivers')]
    public function test_was_inserted_tracks_generated_rows(string $driver): void
    {
        self::onCase($driver, static function (Polyspec\Orm\Db $db): void {
            $outer = 0;
            $nested = 0;
            $db->transaction(function () use ($db, &$outer, &$nested): void {
                $row = (new \Polyspec\Orm\Tests\WasInsertedCase\ClockEvent())($db)->setLabel('outer')->create();
                $outer = (int) $row->getSeq();
                self::assertTrue($db->utils()->wasInserted('clock_event', $outer), 'the outer insert is recorded');
                self::assertFalse(
                    $db->utils()->wasInserted('clock_event', $outer + 1000),
                    'a key that was never inserted is not recorded'
                );
                try {
                    $db->transaction(function () use ($db, &$nested): void {
                        $row = (
                            new \Polyspec\Orm\Tests\WasInsertedCase\ClockEvent()
                        )($db)->setLabel('nested')->create();
                        $nested = (int) $row->getSeq();
                        self::assertTrue(
                            $db->utils()->wasInserted('clock_event', $nested),
                            'the nested insert is recorded'
                        );
                        throw new \RuntimeException('roll back the nested savepoint');
                    }, retry: 0);
                    self::fail('the nested transaction unexpectedly committed');
                } catch (\RuntimeException) {
                }
                self::assertFalse(
                    $db->utils()->wasInserted('clock_event', $nested),
                    'a rolled back insert leaves the write set'
                );
                self::assertTrue(
                    $db->utils()->wasInserted('clock_event', $outer),
                    'the outer insert survives a nested rollback'
                );
            }, retry: 0);
        });
    }

    /** The utility needs an active transaction and a valid entity and key; each violation is CONFIG. */
    #[DataProvider('drivers')]
    public function test_was_inserted_needs_a_transaction_and_valid_arguments(string $driver): void
    {
        self::onCase($driver, static function (Polyspec\Orm\Db $db): void {
            self::assertSame(
                Code::CONFIG,
                self::codeOf(static fn() => $db->utils()->wasInserted('clock_event', 1)),
                'outside a transaction'
            );
            $db->transaction(static function () use ($db): void {
                self::assertSame(
                    Code::CONFIG,
                    self::codeOf(static fn() => $db->utils()->wasInserted('', 1)),
                    'an empty entity'
                );
                self::assertSame(
                    Code::CONFIG,
                    self::codeOf(static fn() => $db->utils()->wasInserted('clock_event', 0)),
                    'a zero key'
                );
                self::assertSame(
                    Code::CONFIG,
                    self::codeOf(static fn() => $db->utils()->wasInserted('clock_event', -1)),
                    'a negative key'
                );
            }, retry: 0);
        });
    }

    /**
     * SQLite and MySQL have no backend lock view: INT-53 answers false without a statement, and an empty pool of
     * PostgreSQL waits for no one.
     */
    #[DataProvider('drivers')]
    public function test_backend_waiting_for_lock_is_false_without_a_waiter(string $driver): void
    {
        self::onCase($driver, static function (Polyspec\Orm\Db $db): void {
            self::assertFalse($db->utils()->backendWaitingForLock(), 'no backend waits for a lock');
        });
    }

    /**
     * PostgreSQL: a second backend that waits for a row lock is reported. The transaction holds the row; a child
     * process updates the same row and blocks. The parent checks the state the database reports, bounded to ten
     * seconds, before it commits and lets the child finish.
     */
    public function test_postgres_reports_a_backend_waiting_for_lock(): void
    {
        self::onCase('postgres', static function (Polyspec\Orm\Db $db, string $dsn): void {
            $seq = 0;
            $db->transaction(static function () use ($db, &$seq): void {
                $seq = (int) (new \Polyspec\Orm\Tests\WasInsertedCase\ClockEvent())($db)->setLabel('held')
                    ->create()
                    ->getSeq();
            }, retry: 0);
            $child = null;
            $pipes = [];
            $db->transaction(function () use ($db, $dsn, $seq, &$child, &$pipes): void {
                (new \Polyspec\Orm\Tests\WasInsertedCase\ClockEvent())($db)->getBySeq($seq)
                    ->setLabel('parent')
                    ->update();
                $child = proc_open(
                    [PHP_BINARY, __DIR__ . '/was_inserted_child.php', $dsn, (string) $seq],
                    [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
                    $pipes
                );
                self::assertIsResource($child, 'the waiting child did not start');
                $waiting = false;
                for ($deadline = microtime(true) + 10; !$waiting && microtime(true) < $deadline; usleep(20000)) {
                    $waiting = $db->utils()->backendWaitingForLock();
                }
                self::assertTrue($waiting, 'the child backend waits for the row lock the transaction holds');
            }, retry: 0);
            self::assertIsResource($child);
            $output = stream_get_contents($pipes[1]);
            $errors = stream_get_contents($pipes[2]);
            fclose($pipes[1]);
            fclose($pipes[2]);
            self::assertSame(0, proc_close($child), "the child exited with an error: $errors");
            self::assertSame("done\n", $output);
        });
    }

    /**
     * The flowmark server has no backend view: INT-53 is CAPABILITY_UNSUPPORTED on the markdown driver, after the
     * connection.
     */
    public function test_markdown_has_no_backend_lock_view(): void
    {
        $server = markdown_fake_server(['{"ok":true}']);
        $db = Orm::connect($server[2], new Config());
        try {
            $error = markdown_error(static fn() => $db->utils()->backendWaitingForLock());
            self::assertSame(
                Code::CAPABILITY_UNSUPPORTED,
                $error?->code_ ?? 'none',
                'backendWaitingForLock on markdown'
            );
        } finally {
            $db->close();
        }
        markdown_received($server);
    }
}
