<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\PrivilegeUtils;
use Polyspec\Orm\SchemaUtils;
use Polyspec\Orm\Stats;
use Polyspec\Orm\Utils;
use Polyspec\Orm\Tests\WasInsertedCases;

#[Medium]
final class UtilsNativeTest extends TestCase
{
    /** @return iterable<string, array{string}> */
    public static function drivers(): iterable
    {
        yield 'sqlite' => ['sqlite'];
        yield 'mysql' => ['mysql'];
        yield 'postgres' => ['postgres'];
    }

    /** Runs the shared utility case against a fresh database of the named driver.
     *
     * @param \Closure(\Polyspec\Orm\Db, string): void $body
     */
    private static function onCase(string $driver, \Closure $body): void
    {
        WasInsertedCases::loadFixture();
        with_case_database($driver, static function (string $step): void {
        }, static function (string $dsn) use ($body): void {
            $separator = str_contains($dsn, '?') ? '&' : '?';
            $db = Orm::connect($dsn . $separator . 'timezone=%2B00:00', new Config());
            try {
                $db->utils()->schema()->install(\Polyspec\Orm\Tests\WasInsertedCase\schema());
                $body($db, $dsn);
            } finally {
                $db->close();
            }
        });
    }

    public function testNativeUtilityConstructorsKeepTheirTypeErrors(): void
    {
        foreach (
            [
                \Polyspec\Orm\AesUtils::class => 'AesUtils',
                PrivilegeUtils::class => 'PrivilegeUtils',
                SchemaUtils::class => 'SchemaUtils',
            ] as $class => $name
        ) {
            try {
                new $class(new \stdClass(), new \stdClass());
                self::fail("$name accepted objects that are not a Db and Utils");
            } catch (\TypeError $error) {
                self::assertSame("$name expects a Db and Utils", $error->getMessage());
            }
        }
    }

    // Requirements: INT-52.
    #[DataProvider('drivers')]
    public function testWasInsertedTracksGeneratedRowsThroughNativeUtils(string $driver): void
    {
        self::assertTrue((new \ReflectionClass(Utils::class))->isInternal());
        self::assertTrue((new \ReflectionClass(Utils::class))->getMethod('wasInserted')->isInternal());

        self::onCase($driver, function (\Polyspec\Orm\Db $db): void {
            WasInsertedCases::assertTracksGeneratedRows($this, $db);
        });
    }

    /** Requirements: INT-53. */
    #[DataProvider('drivers')]
    public function testBackendWaitingForLockIsFalseWithoutAWaiterThroughNativeUtils(string $driver): void
    {
        self::assertTrue((new \ReflectionClass(Utils::class))->isInternal());
        self::assertTrue((new \ReflectionClass(Utils::class))->getMethod('backendWaitingForLock')->isInternal());

        self::onCase($driver, static function (\Polyspec\Orm\Db $db): void {
            self::assertFalse($db->utils()->backendWaitingForLock(), 'no backend waits for a lock');
        });
    }

    /** Requirements: INT-53. PostgreSQL reports the child backend while it waits for the row held here. */
    public function testPostgresReportsABackendWaitingForLockThroughNativeUtils(): void
    {
        self::assertTrue((new \ReflectionClass(Utils::class))->isInternal());
        self::assertTrue((new \ReflectionClass(Utils::class))->getMethod('backendWaitingForLock')->isInternal());

        self::onCase('postgres', static function (\Polyspec\Orm\Db $db, string $dsn): void {
            $seq = 0;
            $db->transaction(static function () use ($db, &$seq): void {
                $seq = (int) (new \Polyspec\Orm\Tests\WasInsertedCase\ClockEvent())($db)->setLabel('held')
                    ->create()
                    ->getSeq();
            }, retry: 0);

            $child = null;
            $pipes = [];
            try {
                $db->transaction(function () use ($db, $dsn, $seq, &$child, &$pipes): void {
                    (new \Polyspec\Orm\Tests\WasInsertedCase\ClockEvent())($db)->getBySeq($seq)
                        ->setLabel('parent')
                        ->update();
                    $child = proc_open(
                        [PHP_BINARY, __DIR__ . '/../../php/tests/was_inserted_child.php', $dsn, (string) $seq],
                        [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
                        $pipes
                    );
                    self::assertIsResource($child, 'the waiting child did not start');
                    $waiting = false;
                    $deadline = microtime(true) + 10;
                    while (!$waiting && microtime(true) < $deadline) {
                        $waiting = $db->utils()->backendWaitingForLock();
                        if (!$waiting) {
                            usleep(20_000);
                        }
                    }
                    self::assertTrue($waiting, 'the child backend waits for the row lock the native transaction holds');
                }, retry: 0);

                self::assertIsResource($child);
                self::assertSame("done\n", stream_get_contents($pipes[1]));
                $errors = stream_get_contents($pipes[2]);
                fclose($pipes[1]);
                fclose($pipes[2]);
                $pipes = [];
                self::assertSame(0, proc_close($child), "the waiting child exited with an error: $errors");
                $child = null;
            } finally {
                foreach ($pipes as $pipe) {
                    if (is_resource($pipe)) {
                        fclose($pipe);
                    }
                }
                if (is_resource($child)) {
                    proc_terminate($child);
                    proc_close($child);
                }
            }
        });
    }

    public function testWasInsertedChecksTransactionBeforeArguments(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'orm-utils-was-inserted-');
        self::assertIsString($path);
        try {
            $db = Orm::connect('sqlite:///' . $path, new Config());
            $events = [];
            $unsubscribe = subscribeToNativeTestEvents($db, $events);
            for ($attempt = 0; $attempt < 2; $attempt++) {
                try {
                    $db->utils()->wasInserted('', 0);
                    self::fail('wasInserted accepted invalid arguments outside a transaction');
                } catch (OrmException $error) {
                    self::assertSame(Code::CONFIG, $error->code_);
                    self::assertSame(
                        'CONFIG: wasInserted requires an active transaction of the connection',
                        $error->getMessage()
                    );
                }
                self::assertSame([], $events);
            }
            $unsubscribe();
            $db->close();
        } finally {
            if (is_file($path)) {
                unlink($path);
            }
        }
    }

    public function testNativeUtilitiesUseTheActiveTransactionAndKeepItsLocalState(): void
    {
        $class = new \ReflectionClass(Utils::class);
        self::assertTrue($class->isInternal());
        foreach (['local', 'lock', 'setLocal', 'wasInserted', 'backendWaitingForLock'] as $method) {
            self::assertTrue($class->getMethod($method)->isInternal());
        }

        $path = tempnam(sys_get_temp_dir(), 'orm-utils-native-');
        self::assertIsString($path);
        try {
            $db = Orm::connect('sqlite:///' . $path, new Config());
            $utils = $db->utils();
            self::assertInstanceOf(SchemaUtils::class, $utils->schema());
            self::assertInstanceOf(PrivilegeUtils::class, $utils->privileges());
            self::assertInstanceOf(Stats::class, $utils->stats());
            self::assertFalse($utils->backendWaitingForLock());

            try {
                $utils->local('trace.id');
                self::fail('local read outside a transaction did not fail');
            } catch (OrmException $error) {
                self::assertSame(Code::CONFIG, $error->code_);
            }

            $value = $utils->run(function () use ($utils): string {
                self::assertSame('nested', $utils->run(static fn(): string => 'nested'));
                $utils->setLocal('trace.id', 'first');
                self::assertSame('first', $utils->local('trace.id'));
                $utils->setLocal('trace.id', 'second');
                self::assertSame('second', $utils->local('trace.id'));
                $utils->lock('native_utils.lock');
                self::assertFalse($utils->wasInserted('Author', 1));
                $utils->exec('utility', [], 'SELECT 1', []);
                self::assertSame(1, $utils->read('utility', [], 'SELECT 1', []));
                return 'complete';
            });
            self::assertSame('complete', $value);

            try {
                $utils->run(static function () use ($utils): void {
                    $utils->local('missing');
                });
                self::fail('a missing local value did not fail');
            } catch (OrmException $error) {
                self::assertSame(Code::NO_ROWS, $error->code_);
            }

            $db->close();
        } finally {
            if (is_file($path)) {
                unlink($path);
            }
        }
    }
}
