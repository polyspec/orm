<?php

// Requirements: FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14.
// The model queries recipe, contracts/fixtures/model_queries/model_queries.json, on each database
// (docs/spec/feature-coverage.md FCV-3 and FCV-4): the generated Author model of the bench set.
// Requirements: DSL-57, DSL-58, DSL-60, DSL-62, DSL-73, DSL-74, DSL-76, DSL-80, DSL-82, DSL-99, INT-16, INT-29, INT-30,
// INT-31, INT-32, INT-33, PLN-11, PLN-25, PRT-35.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;

#[Medium]
class ModelQueriesRecipeTest extends DatabaseRecipeTestCase
{
    protected static function recipe(): string
    {
        return 'contracts/fixtures/model_queries/model_queries.json';
    }
}
