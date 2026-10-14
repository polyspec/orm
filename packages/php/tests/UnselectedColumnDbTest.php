<?php
// Unselected columns on the seeded bench database of ORM_UNSELECTED_DATABASE and ORM_UNSELECTED_DSN, which the test
// requires (scripts/unselected-column-physical-check.mjs sets them): a getter of a column the read did not select fails
// with COLUMN_UNSELECTED for every column type, and a selected SQL NULL stays null. The test only reads.
// Usage: packages/php/vendor/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/UnselectedColumnDbTest.php
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

    public function test_unselected_column(): void
    {
        $driver = getenv('ORM_UNSELECTED_DATABASE');
        $dsn = getenv('ORM_UNSELECTED_DSN');
        if (!in_array($driver, ['mysql', 'postgres', 'sqlite'], true) || !is_string($dsn) || $dsn === '') {
            throw new RuntimeException('ORM_UNSELECTED_DATABASE and ORM_UNSELECTED_DSN are required');
        }
        $db = \Polyspec\Orm\Tests\Model\connect($dsn, new Config(aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index'));
        try {
            self::assertSame($driver, $db->driver(), 'DSN selected the wrong database');
            $row = (new Author)($db)->removeAllColumns()->addColumnSeq()->getBySeq(1);
            $seq = $row->getSeq();
            self::assertGreaterThanOrEqual(1, $seq, 'selected seq is invalid');
            self::requireUnselected(static fn() => $row->getName(), 'text');
            self::requireUnselected(static fn() => $row->getIsClose(), 'boolean');
            self::requireUnselected(static fn() => $row->getDescription(), 'nullable text');
            self::requireUnselected(static fn() => $row->getCreatedTs(), 'date');
            self::requireUnselected(static fn() => $row->getPrice(), 'nullable decimal');
            $selected = (new Author)($db)->removeAllColumns()->addColumnSeq()->addColumnPrice()->getBySeq($seq);
            self::assertTrue($selected->getSeq() === $seq && $selected->getPrice() === null, 'selected SQL NULL changed');
        } finally {
            $db->close();
        }
    }
}
