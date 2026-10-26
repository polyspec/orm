<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use ReflectionMethod;
use RuntimeException;

#[Medium]
final class ConnectionStatementTimeoutNativeTest extends TestCase
{
    // Requirements: CFG-6.
    public function testNativeStatementTimeoutCancelsAndReusesConnection(): void
    {
        self::assertTrue((new ReflectionMethod(Orm::class, 'connect'))->isInternal());
        foreach (['mysql' => 'ORM_TEST_MYSQL_DSN', 'postgres' => 'ORM_TEST_POSTGRES_DSN'] as $driver => $name) {
            $dsn = requiredDsn($name);
            if (!is_string($dsn) || $dsn === '') {
                throw new RuntimeException("$name is not set; run make orm-test-servers");
            }
            $table = 'orm_timeout_native_' . getmypid() . '_' . bin2hex(random_bytes(4));
            $quotedTable = $driver === 'mysql' ? "`$table`" : "\"$table\"";
            $setup = null;
            $holder = null;
            $bounded = null;
            $failure = null;
            try {
                $setup = Orm::connect($dsn, new Config());
                $setup->pdo()->exec("CREATE TABLE $quotedTable (id INTEGER PRIMARY KEY)");
                $setup->pdo()->exec("INSERT INTO $quotedTable (id) VALUES (1)");

                $holder = Orm::connect($dsn, new Config());
                $holder->pdo()->beginTransaction();
                $holder->pdo()->exec("UPDATE $quotedTable SET id = id");
                $bounded = Orm::connect($dsn, new Config(statementTimeoutMs: 200));
                try {
                    $bounded->transaction(
                        static fn() => $bounded->fetch(
                            'query',
                            [],
                            null,
                            "SELECT id FROM $quotedTable WHERE id = 1 FOR UPDATE"
                        ),
                        retry: 0
                    );
                    self::fail("$driver: the locking read passed its statement timeout");
                } catch (OrmException $error) {
                    self::assertSame(Code::CANCELED, $error->code_, "$driver: {$error->getMessage()}");
                }
                $holder->pdo()->rollBack();
                self::assertCount(
                    1,
                    $bounded->fetch('query', [], null, "SELECT id FROM $quotedTable WHERE id = 1"),
                    "$driver: connection reuse after cancellation"
                );
            } catch (\Throwable $error) {
                $failure = $error;
            } finally {
                $cleanupErrors = [];
                if ($holder !== null) {
                    try {
                        if ($holder->pdo()->inTransaction()) {
                            $holder->pdo()->rollBack();
                        }
                    } catch (\Throwable $error) {
                        $cleanupErrors[] = $error;
                    }
                }
                array_push($cleanupErrors, ...self::closeConnections([$bounded, $holder]));
                if ($setup !== null) {
                    try {
                        $setup->pdo()->exec("DROP TABLE IF EXISTS $quotedTable");
                    } catch (\Throwable $error) {
                        $cleanupErrors[] = $error;
                    }
                }
                if ($setup !== null) {
                    try {
                        $setup->close();
                    } catch (\Throwable $error) {
                        $cleanupErrors[] = $error;
                    }
                }
                if ($cleanupErrors !== []) {
                    $messages = array_map(static fn(\Throwable $error): string => $error->getMessage(), $cleanupErrors);
                    $message = "$driver: timeout fixture cleanup failed: " . implode('; ', $messages);
                    throw new RuntimeException($message, 0, $failure ?? $cleanupErrors[0]);
                }
            }
            if ($failure !== null) {
                throw $failure;
            }
        }
    }

    // Requirements: CFG-27, CFG-28, CFG-29.
    public function testNativeStatementTimeoutIsIsolatedByTransactionPooler(): void
    {
        self::assertTrue((new ReflectionMethod(Orm::class, 'connect'))->isInternal());
        $base = requiredDsn('ORM_TEST_POSTGRES_DSN');
        $single = requiredDsn('ORM_TEST_PGBOUNCER_SINGLE_DSN');
        if (!is_string($base) || $base === '') {
            throw new RuntimeException('ORM_TEST_POSTGRES_DSN is not set; run make orm-test-servers');
        }
        if (!is_string($single) || $single === '') {
            throw new RuntimeException('ORM_TEST_PGBOUNCER_SINGLE_DSN is not set; run make orm-test-servers');
        }

        $holder = Orm::connect($base, new Config());
        $bounded = null;
        $plain = null;
        $lock = random_int(1, 2147483647);
        $locked = false;
        $failure = null;
        try {
            $default = $holder->fetch('query', [], null, "SELECT current_setting('statement_timeout')")[0][0];
            $holder->fetch('query', [], null, 'SELECT pg_advisory_lock($1)', [$lock]);
            $locked = true;

            $bounded = Orm::connect($single, new Config(statementTimeoutMs: 200));
            try {
                $bounded->fetch('query', [], null, 'SELECT pg_advisory_xact_lock($1)', [$lock]);
                self::fail('the bounded connection completed an advisory lock past its timeout');
            } catch (OrmException $error) {
                self::assertSame(Code::CANCELED, $error->code_, $error->getMessage());
            }
            self::assertCount(
                1,
                $bounded->fetch('query', [], null, 'SELECT 1'),
                'the bounded native connection is usable after cancellation'
            );

            $plain = Orm::connect($single, new Config());
            // Both native client sessions reuse the same bound query in repeated transactions through PgBouncer.
            for ($i = 0; $i < 6; $i++) {
                $boundedRows = $bounded->transaction(
                    fn(): array => $bounded->fetch('query', [], null, 'SELECT $1::integer', [1]),
                    retry: 0
                );
                $plainRows = $plain->transaction(
                    fn(): array => $plain->fetch('query', [], null, 'SELECT $1::integer', [1]),
                    retry: 0
                );
                self::assertSame([[1]], array_map(static fn(array $row): array => [(int) $row[0]], $boundedRows));
                self::assertSame([[1]], array_map(static fn(array $row): array => [(int) $row[0]], $plainRows));
            }
            $setting = $plain->fetch('query', [], null, "SELECT current_setting('statement_timeout')")[0][0];
            self::assertSame($default, $setting, 'the bounded client did not change another pooler client timeout');
        } catch (\Throwable $error) {
            $failure = $error;
        } finally {
            $cleanupErrors = [];
            if ($locked) {
                try {
                    $holder->fetch('query', [], null, 'SELECT pg_advisory_unlock($1)', [$lock]);
                } catch (\Throwable $error) {
                    $cleanupErrors[] = $error;
                }
            }
            array_push($cleanupErrors, ...self::closeConnections([$plain, $bounded, $holder]));
            if ($cleanupErrors !== []) {
                $messages = array_map(static fn(\Throwable $error): string => $error->getMessage(), $cleanupErrors);
                $message = 'pooler timeout cleanup failed: ' . implode('; ', $messages);
                throw new RuntimeException($message, 0, $failure ?? $cleanupErrors[0]);
            }
        }
        if ($failure !== null) {
            throw $failure;
        }
    }

    /** @param list<?\Polyspec\Orm\Db> $connections
     * @return list<\Throwable>
     */
    private static function closeConnections(array $connections): array
    {
        $errors = [];
        foreach ($connections as $connection) {
            if ($connection === null) {
                continue;
            }
            try {
                $connection->close();
            } catch (\Throwable $error) {
                $errors[] = $error;
            }
        }
        return $errors;
    }
}
