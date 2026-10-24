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
        foreach (
            [
                'mysql' => ['ORM_TEST_MYSQL_DSN', 'SELECT SLEEP(1)'],
                'postgres' => ['ORM_TEST_POSTGRES_DSN', 'SELECT pg_sleep(1)'],
            ] as $driver => [$name, $sql]
        ) {
            $dsn = requiredDsn($name);
            if (!is_string($dsn) || $dsn === '') {
                throw new RuntimeException("$name is not set; run make orm-test-servers");
            }
            $db = Orm::connect($dsn, new Config(statementTimeoutMs: 200));
            try {
                try {
                    $db->fetch('query', [], null, $sql);
                    self::fail("$driver: the statement passed its timeout");
                } catch (OrmException $error) {
                    self::assertSame(Code::CANCELED, $error->code_, "$driver: {$error->getMessage()}");
                }
                self::assertCount(1, $db->fetch('query', [], null, 'SELECT 1'), "$driver: connection reuse");
            } finally {
                $db->close();
            }
        }
    }

    // Requirements: CFG-27, CFG-29.
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

        $holder = Orm::connect($base);
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
            self::assertCount(1, $bounded->fetch('query', [], null, 'SELECT 1'), 'the bounded native connection is usable after cancellation');

            $plain = Orm::connect($single);
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
            foreach ([$plain, $bounded, $holder] as $db) {
                if ($db === null) {
                    continue;
                }
                try {
                    $db->close();
                } catch (\Throwable $error) {
                    $cleanupErrors[] = $error;
                }
            }
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
}
