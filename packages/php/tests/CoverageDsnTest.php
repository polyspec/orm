<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// dsn feature coverage: an unsupported DSN scheme is refused with the config code, and the DSN of the selected database
// (ORM_FEATURE_DATABASE, ORM_FEATURE_DSN) connects to that database.


use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use ReflectionMethod;

#[Medium]
class CoverageDsnTest extends TestCase
{
    protected static function coverageTestFile(): string
    {
        return __FILE__;
    }

    // Requirements: CFG-1, INT-13.
    public function testDsnConnection(): void
    {
        foreach (coverageItemsOf(static::coverageTestFile()) as $item) {
            selectCoverageItem($item);
            [$driver, $dsn] = coverageItem();
            $this->assertSame(
                Code::CONFIG,
                coverageCode(static fn() => Orm::parseDsn('invalid://database')),
                'unsupported DSN scheme'
            );
            $db = Orm::connect($dsn, new Config());
            try {
                $this->assertSame($driver, $db->driver(), 'DSN selected the wrong database');
                $this->assertSame(
                    1,
                    (int) $db->pdo()->query('SELECT 1')->fetchColumn(),
                    'DSN selected the wrong connection'
                );
            } finally {
                $db->close();
            }
        }
    }

    // Requirements: DSL-150.
    public function testSqliteMinimumVersionValidation(): void
    {
        $method = new ReflectionMethod(Orm::class, 'assertSqliteVersion');
        try {
            $method->invoke(null, '3.9.0');
            self::fail('SQLite 3.9.0 must be refused');
        } catch (OrmException $error) {
            self::assertSame(Code::CAPABILITY_UNSUPPORTED, $error->code_);
            self::assertSame('CAPABILITY_UNSUPPORTED: SQLite 3.9.0 is older than 3.46', $error->getMessage());
        }

        $method->invoke(null, '3.46.0');
        $method->invoke(null, '3.100.0');

        self::onSqliteFile('orm-sqlite-version-', static function (\Polyspec\Orm\Db $db): void {
            self::assertSame('sqlite', $db->driver());
        });
    }

    /**
     * Runs $body on a connection to a new SQLite file whose name starts with $prefix; the connection closes, and the
     * file and its journals are removed afterwards.
     *
     * @param \Closure(\Polyspec\Orm\Db): void $body
     */
    protected static function onSqliteFile(string $prefix, \Closure $body): void
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
