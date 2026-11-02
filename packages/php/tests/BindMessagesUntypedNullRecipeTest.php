<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

// The markdown message and control recipe, tests/bind/messages-untyped-null.json, without a database
// (docs/spec/feature-coverage.md FCV-3, FCV-4). Requirements: PRT-67.
#[Medium]
class BindMessagesUntypedNullRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'tests/bind/messages-untyped-null.json';
    }

    #[DataProvider('cases')]
    public function testNone(array $case): void
    {
        $this->runCase($case, Recipe::NONE);
    }
}
