<?php

// The request validation recipe, tests/ir/validate.json, without a database (docs/spec/feature-coverage.md FCV-3).
// Requirements: PRT-1, INT-24, PRT-4, PRT-6, PRT-8, PRT-10, PRT-12, PRT-14, PRT-16, PRT-17, PRT-18, PRT-20, PRT-21, PRT-22,
// PRT-24, PRT-78, DBS-59, DBS-113, DSL-113, DSL-128.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
class IrValidateRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'tests/ir/validate.json';
    }

    #[DataProvider('cases')]
    public function testNone(string $id): void
    {
        $this->runCase($id, Recipe::NONE);
    }
}
