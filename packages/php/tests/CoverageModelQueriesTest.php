<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// model_queries feature coverage: reads the bench database seeded with the generated bench model
// (scripts/bench-db.sh). author seq i is user_seq i%5000+1,
// service_seq i%100+1, read_count i%1000, and the name of user seq n is user-n.


use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
final class CoverageModelQueriesTest extends TestCase
{
    // Requirements: DSL-57, DSL-58, DSL-60, DSL-62, DSL-73, DSL-74, DSL-80, DSL-82, DSL-99.
    // Requirements: INT-16, INT-29, INT-30, INT-32, INT-33, PLN-11, PLN-25.
    public function testModelQueryRows(): void
    {
        require_once __DIR__ . '/CoverageModelQueriesCase.php';
        coverageAssertEntryClassesAreInternal();
        coverageRunDatabaseItems(__FILE__, static function (\Polyspec\Orm\Db $db): void {
            CoverageModelQueriesCase::run($db);
        });
    }

    // Requirements: DSL-76.
    public function testRemoveColumnsKeysAndAddedColumn(): void
    {
        require_once __DIR__ . '/CoverageModelQueriesCase.php';
        coverageRunDatabaseItems(__FILE__, static function (\Polyspec\Orm\Db $db): void {
            CoverageModelQueriesCase::removeColumns($db);
        });
    }
}
