<?php

// Unselected columns on the seeded bench database of each dialect (BENCH_<DIALECT>_DSN, from make databases-create): a
// getter of a column the read did not select fails with COLUMN_UNSELECTED for every column type, and a selected SQL
// NULL stays null. The test only reads.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist
// packages/php/tests/UnselectedColumnDbTest.php
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Db;
use Polyspec\Orm\Tests\Model\Author;

#[Medium]
final class UnselectedColumnDbTest extends TestCase
{
    use DatabaseTestAssertions;

    public function testUnselectedColumn(): void
    {
        $this->forEachBenchDatabase(static function (Db $db): void {
            $row = (new Author())($db)->removeAllColumns()->addColumnSeq()->getBySeq(1);
            $seq = $row->getSeq();
            self::assertGreaterThanOrEqual(1, $seq, 'selected seq is invalid');
            self::assertColumnUnselected(static fn() => $row->getName(), 'text');
            self::assertColumnUnselected(static fn() => $row->getIsClose(), 'boolean');
            self::assertColumnUnselected(static fn() => $row->getDescription(), 'nullable text');
            self::assertColumnUnselected(static fn() => $row->getCreatedTs(), 'date');
            self::assertColumnUnselected(static fn() => $row->getPrice(), 'nullable decimal');
            $selected = (new Author())($db)->removeAllColumns()->addColumnSeq()->addColumnPrice()->getBySeq($seq);
            self::assertTrue(
                $selected->getSeq() === $seq && $selected->getPrice() === null,
                'selected SQL NULL changed'
            );
        });
    }
}
