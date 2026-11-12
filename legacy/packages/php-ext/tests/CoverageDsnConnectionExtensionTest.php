<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Orm;
use ReflectionMethod;

// Requirements: DSL-150. The inherited minimum-version case runs the same check through native Orm methods.
#[Medium]
final class CoverageDsnConnectionExtensionTest extends CoverageDsnTest
{
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
    /**
     * Runs $body on a connection to a new SQLite file whose name starts with $prefix; the connection closes, and the
     * file and its journals are removed afterwards.
     *
     * @param \Closure(Db): void $body
     */
    private static function onSqliteFile(string $prefix, \Closure $body): void
    {
        $path = tempnam(sys_get_temp_dir(), $prefix);
        self::assertNotFalse($path);
        $db = null;
        try {
            $db = Orm::connect('sqlite://' . $path, new Config());
            $body($db);
        } finally {
            $db?->close();
            foreach ([$path, $path . '-journal', $path . '-wal', $path . '-shm'] as $file) {
                if (is_file($file)) {
                    unlink($file);
                }
            }
        }
    }
}
