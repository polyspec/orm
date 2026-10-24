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

require_once dirname(__DIR__, 2) . '/php/tests/CoverageDsnTest.php';

#[Medium]
final class CoverageDsnConnectionExtensionTest extends CoverageDsnTest
{
    protected static function coverageTestFile(): string
    {
        return __FILE__;
    }

    public function test_native_methods_are_internal(): void
    {
        Assert::assertTrue((new ReflectionMethod(Orm::class, 'parseDsn'))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Orm::class, 'connect'))->isInternal());
    }

    public function test_native_sqlite_connection_queries_and_closes(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'orm-lifecycle-dsn-');
        self::assertNotFalse($path);

        $db = null;
        try {
            $db = Orm::connect('sqlite://' . $path, new Config());
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
