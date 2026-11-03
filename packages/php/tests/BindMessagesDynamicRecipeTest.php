<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

// The markdown message and control recipe, tests/bind/messages-dynamic.json, without a database
// (docs/spec/feature-coverage.md FCV-3, FCV-4). Requirements: PRT-67.
#[Medium]
class BindMessagesDynamicRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'tests/bind/messages-dynamic.json';
    }

    #[DataProvider('cases')]
    public function testNone(string $id): void
    {
        $this->runCase($id, Recipe::NONE);
    }
}
