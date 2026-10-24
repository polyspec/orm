<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Closure;
use DateTimeZone;
use PDO;
use PDOException;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Testing\Faults;
use RuntimeException;

trait TransactionFailureCases
{
    private function assertCallbackDriverError(string $message, PDOException $driver, Closure $operation): void
    {
        $pdo = new ModelTestFailingPdo('sqlite::memory:');
        $db = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));
        try {
            $error = $this->ormFailure($message, static fn() => $operation($db, $driver));
            self::assertSame(Code::DRIVER, $error->code_);
            self::assertSame($driver, $error->getPrevious());
        } finally {
            $db->close();
        }
    }

    private function ormFailure(string $message, Closure $operation): OrmException
    {
        try {
            $operation();
            self::fail($message);
        } catch (OrmException $error) {
            return $error;
        }
    }

    public function testTransactionMapsDriverCallbackError(): void
    {
        $this->assertCallbackDriverError(
            'a driver exception must be normalized',
            new PDOException('transaction callback driver failure'),
            static fn(Db $db, PDOException $driver) => $db->transaction(static function () use ($driver): never {
                throw $driver;
            }, retry: 0)
        );
    }

    // Requirements: INT-67.
    public function testCallbackUnwindRollsBackAndReusesTheConnection(): void
    {
        $pdo = new ModelTestFailingPdo('sqlite::memory:');
        $pdo->exec('CREATE TABLE transaction_unwind (value TEXT NOT NULL)');
        $db = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));
        $failure = new RuntimeException('transaction callback abandoned its work');

        try {
            try {
                $db->transaction(static function () use ($pdo, $failure): never {
                    $pdo->exec("INSERT INTO transaction_unwind VALUES ('rolled back')");
                    throw $failure;
                }, retry: 0);
                self::fail('the callback failure must escape after rollback');
            } catch (RuntimeException $error) {
                self::assertSame($failure, $error, 'callback unwind preserves the original failure');
            }

            self::assertSame(
                [],
                $pdo->query('SELECT value FROM transaction_unwind')->fetchAll(PDO::FETCH_COLUMN),
                'the callback write is absent after rollback'
            );
            $db->transaction(static function () use ($pdo): void {
                $pdo->exec("INSERT INTO transaction_unwind VALUES ('committed')");
            }, retry: 0);
            self::assertSame(
                ['committed'],
                $pdo->query('SELECT value FROM transaction_unwind')->fetchAll(PDO::FETCH_COLUMN),
                'the same PDO connection works for the next transaction'
            );
        } finally {
            $db->close();
        }
    }

    // Requirements: INT-72.
    public function testRollbackFaultIsConsumedAfterTransactionRollback(): void
    {
        require_once dirname(__DIR__) . '/testing/Faults.php';
        $pdo = new ModelTestFailingPdo('sqlite::memory:');
        $pdo->exec('CREATE TABLE transaction_failure_rollback_fault (label TEXT NOT NULL)');
        $db = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));
        try {
            Faults::failNextRollback($db);
            $db->transaction(static function () use ($pdo): void {
                $pdo->exec("INSERT INTO transaction_failure_rollback_fault VALUES ('committed')");
            }, retry: 0);

            $callback = new RuntimeException('rollback fault callback failed');
            $failing = static function () use ($pdo, $callback): never {
                $pdo->exec("INSERT INTO transaction_failure_rollback_fault VALUES ('rolled back')");
                throw $callback;
            };
            try {
                $db->transaction($failing, retry: 0);
                self::fail('a failed rollback with an armed fault must report ROLLBACK');
            } catch (OrmException $error) {
                self::assertSame(Code::ROLLBACK, $error->code_);
                self::assertSame($callback, $error->getPrevious());
                self::assertSame(Code::FAULT, $error->rollback?->code_);
            }
            self::assertSame(['committed'], $pdo->query(
                'SELECT label FROM transaction_failure_rollback_fault ORDER BY label'
            )->fetchAll(PDO::FETCH_COLUMN));

            try {
                $db->transaction($failing, retry: 0);
                self::fail('the consumed rollback fault must not affect the next transaction');
            } catch (RuntimeException $error) {
                self::assertSame($callback, $error);
            }
            self::assertSame(['committed'], $pdo->query(
                'SELECT label FROM transaction_failure_rollback_fault ORDER BY label'
            )->fetchAll(PDO::FETCH_COLUMN));
        } finally {
            $db->close();
        }
    }

    public function testSavepointMapsDriverCallbackError(): void
    {
        $this->assertCallbackDriverError(
            'a savepoint driver exception must be normalized',
            new PDOException('savepoint callback driver failure'),
            static fn(Db $db, PDOException $driver) => $db->transaction(
                static function () use ($db, $driver): void {
                    $db->transaction(static function () use ($driver): never {
                        throw $driver;
                    });
                },
                retry: 0
            )
        );
    }

    public function testTransactionKeepsCallbackAndFailedRollbackErrors(): void
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
                self::assertSame(
                    'rollback rejected by the test driver',
                    $error->rollback?->getPrevious()?->getMessage()
                );
                self::assertSame(
                    'ROLLBACK: transaction failed (transaction callback failed) and rollback failed'
                    . ' (DRIVER: rollback rejected by the test driver)',
                    $error->getMessage()
                );
            }
        } finally {
            $db->close();
        }
    }

    public function testSavepointAttemptsBothEndStepsAndKeepsTheCallbackError(): void
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
