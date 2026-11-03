<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

// The read answer recipe, tests/ir/answers.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
// Requirements: PRT-69, PRT-71, PRT-72.
#[Medium]
class IrAnswersTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'tests/ir/answers.json';
    }

    #[DataProvider('cases')]
    public function testNone(string $id): void
    {
        $this->runCase($id, Recipe::NONE);
    }
}
