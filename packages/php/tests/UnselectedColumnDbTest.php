<?php

// Unselected columns on the seeded bench database of each dialect (BENCH_<DIALECT>_DSN, from make databases-create): a
// getter of a column the read did not select fails with COLUMN_UNSELECTED for every column type, and a selected SQL
// NULL stays null. The test only reads.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist
// packages/php/tests/UnselectedColumnDbTest.php
declare(strict_types=1);

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Tests\Model\Author;

#[Medium]
final class UnselectedColumnDbTest extends TestCase
{
    private static function requireUnselected(callable $read, string $column): void
    {
        try {
            $read();
        } catch (OrmException $error) {
            self::assertSame(Code::COLUMN_UNSELECTED, $error->code_, "unselected $column: {$error->getMessage()}");
            return;
        }
        self::fail("unselected $column returned a value");
    }

    public function testUnselectedColumn(): void
    {
        foreach (
            [
            'mysql' => 'BENCH_MYSQL_DSN',
            'postgres' => 'BENCH_POSTGRES_DSN',
            'sqlite' => 'BENCH_SQLITE_DSN'
            ] as $driver => $variable
        ) {
            $dsn = requiredDsn($variable);
            $db = \Polyspec\Orm\Tests\Model\connect(
                $dsn,
                new Config(aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index')
            );
            try {
                self::assertSame($driver, $db->driver(), 'DSN selected the wrong database');
                $row = (new Author())($db)->removeAllColumns()->addColumnSeq()->getBySeq(1);
                $seq = $row->getSeq();
                self::assertGreaterThanOrEqual(1, $seq, 'selected seq is invalid');
                self::requireUnselected(static fn() => $row->getName(), 'text');
                self::requireUnselected(static fn() => $row->getIsClose(), 'boolean');
                self::requireUnselected(static fn() => $row->getDescription(), 'nullable text');
                self::requireUnselected(static fn() => $row->getCreatedTs(), 'date');
                self::requireUnselected(static fn() => $row->getPrice(), 'nullable decimal');
                $selected = (new Author())($db)->removeAllColumns()->addColumnSeq()->addColumnPrice()->getBySeq($seq);
                self::assertTrue(
                    $selected->getSeq() === $seq && $selected->getPrice() === null,
                    'selected SQL NULL changed'
                );
            } finally {
                $db->close();
            }
        }
    }
}
