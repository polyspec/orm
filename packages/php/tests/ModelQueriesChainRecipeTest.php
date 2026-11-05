<?php

// The model query chains recipe, contracts/fixtures/model_queries_chain/model_queries_chain.json, on each database
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: DSL-57, DSL-58, DSL-60, DSL-62, DSL-73, DSL-74, DSL-76, DSL-80, DSL-82, DSL-90, DSL-99, INT-16, INT-29,
// Requirements: INT-30, INT-31, INT-32, INT-33, INT-36, INT-87, PLN-11, PLN-25, PRT-35, FCV-8, FCV-9, FCV-10, FCV-11,
// Requirements: FCV-12, FCV-13, FCV-14 (docs/spec/feature-coverage.md).

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;

#[Medium]
class ModelQueriesChainRecipeTest extends DatabaseRecipeTestCase
{
    protected static function recipe(): string
    {
        return 'contracts/fixtures/model_queries_chain/model_queries_chain.json';
    }
}
