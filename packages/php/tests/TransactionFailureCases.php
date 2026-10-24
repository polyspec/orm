<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use DateTimeZone;
use PDOException;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\OrmException;
use RuntimeException;

trait TransactionFailureCases
{
    public function test_transaction_maps_driver_callback_error(): void
    {
        $pdo = new ModelTestFailingPdo('sqlite::memory:');
        $db = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));
        $driver = new PDOException('transaction callback driver failure');

        try {
            try {
                $db->transaction(static function () use ($driver): never {
                    throw $driver;
                }, retry: 0);
                self::fail('a driver exception must be normalized');
            } catch (OrmException $error) {
                self::assertSame(Code::DRIVER, $error->code_);
                self::assertSame($driver, $error->getPrevious());
            }
        } finally {
            $db->close();
        }
    }

    public function test_savepoint_maps_driver_callback_error(): void
    {
        $pdo = new ModelTestFailingPdo('sqlite::memory:');
        $db = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));
        $driver = new PDOException('savepoint callback driver failure');

        try {
            try {
                $db->transaction(static function () use ($db, $driver): void {
                    $db->transaction(static function () use ($driver): never {
                        throw $driver;
                    });
                }, retry: 0);
                self::fail('a savepoint driver exception must be normalized');
            } catch (OrmException $error) {
                self::assertSame(Code::DRIVER, $error->code_);
                self::assertSame($driver, $error->getPrevious());
            }
        } finally {
            $db->close();
        }
    }

    public function test_transaction_keeps_callback_and_failed_rollback_errors(): void
    {
        $pdo = new ModelTestFailingPdo('sqlite::memory:');
        $pdo->rejectRollback = true;
        $db = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));
        $callback = new RuntimeException('transaction callback failed');

        try {
            try {
                $db->transaction(static function () use ($callback): never {
                    throw $callback;
                }, retry: 0);
                self::fail('a failed rollback must be reported');
            } catch (OrmException $error) {
                self::assertSame(Code::ROLLBACK, $error->code_);
                self::assertSame($callback, $error->getPrevious());
                self::assertSame('DRIVER', $error->rollback?->code_);
                self::assertSame('rollback rejected by the test driver', $error->rollback?->getPrevious()?->getMessage());
                self::assertSame(
                    'ROLLBACK: transaction failed (transaction callback failed) and rollback failed (DRIVER: rollback rejected by the test driver)',
                    $error->getMessage()
                );
            }
        } finally {
            $db->close();
        }
    }

    public function test_savepoint_attempts_both_end_steps_and_keeps_the_callback_error(): void
    {
        $scenarios = [
            'rollback-only' => ['ROLLBACK TO SAVEPOINT '],
            'release-only' => ['RELEASE SAVEPOINT '],
            'both-endpoints' => ['ROLLBACK TO SAVEPOINT ', 'RELEASE SAVEPOINT '],
        ];
        foreach ($scenarios as $scenario => $rejected) {
            $pdo = new ModelTestFailingPdo('sqlite::memory:');
            $pdo->rejects = static function (string $sql) use ($rejected): bool {
                foreach ($rejected as $prefix) {
                    if (str_starts_with($sql, $prefix)) {
                        return true;
                    }
                }
                return false;
            };
            $db = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));
            $callback = new RuntimeException('savepoint callback failed');
            try {
                try {
                    $db->transaction(static function () use ($db, $callback): void {
                        $db->transaction(static function () use ($callback): never {
                            throw $callback;
                        });
                    }, retry: 0);
                    self::fail("$scenario: a failed savepoint end must be reported");
                } catch (OrmException $error) {
                    self::assertSame(Code::ROLLBACK, $error->code_, $scenario);
                    self::assertSame($callback, $error->getPrevious(), $scenario);
                    self::assertSame(
                        count($rejected) === 2 ? 'CONFIG' : 'DRIVER',
                        $error->rollback?->code_,
                        $scenario
                    );
                    self::assertSame(
                        count($rejected),
                        substr_count($error->rollback?->getMessage() ?? '', 'statement rejected by the test driver'),
                        $scenario
                    );
                    $controls = array_values(array_filter(
                        $pdo->statements,
                        static fn(string $sql): bool => str_starts_with($sql, 'ROLLBACK TO SAVEPOINT ')
                            || str_starts_with($sql, 'RELEASE SAVEPOINT ')
                    ));
                    self::assertSame(
                        ['ROLLBACK TO SAVEPOINT orm_sp_1', 'RELEASE SAVEPOINT orm_sp_1'],
                        $controls,
                        $scenario
                    );
                }
            } finally {
                $db->close();
            }
        }

        $pdo = new ModelTestFailingPdo('sqlite::memory:');
        $pdo->rejects = static fn(string $sql): bool => str_starts_with($sql, 'RELEASE SAVEPOINT ');
        $db = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));
        try {
            try {
                $db->transaction(static function () use ($db): void {
                    $db->transaction(static fn() => null);
                }, retry: 0);
                self::fail('a successful savepoint callback with a failed release must be reported');
            } catch (OrmException $error) {
                self::assertSame(Code::DRIVER, $error->code_);
                self::assertInstanceOf(\PDOException::class, $error->getPrevious());
                self::assertStringContainsString('statement rejected by the test driver', $error->getMessage());
                self::assertStringNotContainsString('savepoint callback failed', $error->getMessage());
                $controls = array_values(array_filter(
                    $pdo->statements,
                    static fn(string $sql): bool => str_starts_with($sql, 'ROLLBACK TO SAVEPOINT ')
                        || str_starts_with($sql, 'RELEASE SAVEPOINT ')
                ));
                self::assertSame(['RELEASE SAVEPOINT orm_sp_1'], $controls);
            }
        } finally {
            $db->close();
        }
    }
}
