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
}
