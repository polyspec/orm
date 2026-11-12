<?php

// The model writes recipe, contracts/fixtures/model_writes/model_writes.json, on each database
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: DSL-56, DSL-57, DSL-58, DSL-60, DSL-103, DSL-104, DSL-105, DSL-106, DSL-109, DSL-110, PLN-26.
// FCV-8, FCV-9, FCV-10, FCV-13 and FCV-14 are the requirements of this recipe unit.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;

#[Medium]
class ModelWritesRecipeTest extends DatabaseRecipeTestCase
{
    protected static function recipe(): string
    {
        return 'contracts/fixtures/model_writes/model_writes.json';
    }
}
