<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Code;
use Polyspec\Orm\Db;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Orm;
use ReflectionMethod;

// Requirements: CFG-1. The inherited DSN case exercises Orm through the native extension.

// Requirements: DSL-150. The inherited minimum-version case runs the same check through native Orm methods.
#[Medium]
final class CoverageDsnConnectionExtensionTest extends CoverageDsnTest
{
    protected static function coverageTestFile(): string
    {
        return __FILE__;
    }

    public function testNativeMethodsAreInternal(): void
    {
        Assert::assertTrue((new ReflectionMethod(Orm::class, 'parseDsn'))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Orm::class, 'connect'))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Orm::class, 'assertSqliteVersion'))->isInternal());
    }

    public function testNativeSqliteConnectionQueriesAndCloses(): void
    {
        self::onSqliteFile('orm-lifecycle-dsn-', static function (Db $db): void {
            self::assertTrue((new ReflectionMethod(Db::class, 'pdo'))->isInternal());
            self::assertTrue((new ReflectionMethod(Db::class, 'close'))->isInternal());
            self::assertSame('sqlite', $db->driver());
            self::assertSame(1, (int) $db->pdo()->query('SELECT 1')->fetchColumn());

            $db->close();
            try {
                $db->pdo();
                self::fail('the closed connection returned its PDO handle');
            } catch (OrmException $error) {
                self::assertSame(Code::CONFIG, $error->code_);
            }
        });
    }
}
