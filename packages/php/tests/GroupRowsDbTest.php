<?php

// Grouped counts on the seeded bench database of each dialect (BENCH_<DIALECT>_DSN, from make databases-create):
// getsCount returns group rows whose grouped values keep their types (boolean, integer, SQL NULL), that hold only the
// grouped columns and the count, and whose counts sum to the row count. The test only reads.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/GroupRowsDbTest.php
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Db;
use Polyspec\Orm\GroupRow;
use Polyspec\Orm\GroupRows;
use Polyspec\Orm\Tests\Model\Author;

#[Medium]
final class GroupRowsDbTest extends TestCase
{
    use DatabaseTestAssertions;
    // Requirements: INT-31. The imported database case checks grouped values and counts on each dialect.
    use GroupRowsDbCases;
}
