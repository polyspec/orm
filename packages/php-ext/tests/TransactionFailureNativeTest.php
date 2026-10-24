<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\TestCase;
use DateTimeZone;
use PDO;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Tests\TransactionFailureCases;
use ReflectionClass;
use ReflectionMethod;

// Requirements: INT-72, DIA-181, PLN-17.
final class TransactionFailureNativeTest extends TestCase
{
    use TransactionFailureCases;

    protected function setUp(): void
    {
        self::assertTrue((new ReflectionClass(Db::class))->isInternal());
    }

    public function testSqliteRowLockEventBelongsToEachTransaction(): void
    {
        $pdo = new PDO('sqlite::memory:');
        $db = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));
        $events = [];
        $db->subscribe(static function (\Polyspec\Orm\StatementEvent $event) use (&$events): void {
            $events[] = [$event->kind, $event->sql, $event->transaction];
        });

        for ($transaction = 1; $transaction <= 2; $transaction++) {
            $db->transaction(static function () use ($db): void {
                $db->acquireSQLiteRowLock('update');
            });
            $expected = [
                ['begin', 'BEGIN IMMEDIATE', $transaction],
                [
                    'utility',
                    'INSERT INTO "orm__row_lock" ("id") VALUES (1) ON CONFLICT ("id") DO UPDATE SET "id"=excluded."id"',
                    $transaction,
                ],
                ['commit', 'COMMIT', $transaction],
            ];
            self::assertSame(
                $expected,
                array_slice($events, -3),
                'the row-lock write is ordered inside its transaction',
            );
            self::assertSame(1, (int) $pdo->query('SELECT COUNT(*) FROM "orm__row_lock"')->fetchColumn());
        }

        $db->close();
    }

    // Requirements: CFG-16.
    public function testNativeOrmConnectsWithTlsIdentity(): void
    {
        self::assertTrue((new ReflectionMethod(Orm::class, 'connect'))->isInternal());
        $dsn = requiredDsn('ORM_TEST_MYSQL_TLS_DSN');
        if (!is_string($dsn) || $dsn === '') {
            throw new \RuntimeException('ORM_TEST_MYSQL_TLS_DSN is not set; run make orm-test-servers');
        }
        $db = Orm::connect($dsn, new Config());
        try {
            $version = (string) ($db->pdo()->query("SHOW SESSION STATUS LIKE 'Ssl_version'")->fetch(\PDO::FETCH_NUM)[1] ?? '');
            self::assertMatchesRegularExpression('/^TLSv1\.[23]$/', $version, 'the native connection uses TLS');
        } finally {
            $db->close();
        }
    }

    // Requirements: CFG-16.
    public function testNativeOrmRejectsUntrustedTlsIdentity(): void
    {
        self::assertTrue((new ReflectionMethod(Orm::class, 'connect'))->isInternal());
        foreach (['ORM_TEST_MYSQL_TLS_OTHER_CA_DSN', 'ORM_TEST_MYSQL_TLS_MISMATCH_DSN'] as $name) {
            $dsn = requiredDsn($name);
            if (!is_string($dsn) || $dsn === '') {
                throw new \RuntimeException("$name is not set; run make orm-test-servers");
            }
            try {
                $db = Orm::connect($dsn, new Config());
            } catch (OrmException $error) {
                self::assertSame(Code::CONFIG, $error->code_, "$name: {$error->getMessage()}");
                self::assertStringContainsString('SSL', $error->getMessage(), "$name: {$error->getMessage()}");
                continue;
            }
            $db->close();
            self::fail("the native connection accepted untrusted TLS identity from $name");
        }
    }
}
