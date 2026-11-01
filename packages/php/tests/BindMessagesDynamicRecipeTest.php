<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

// The markdown message and control recipe, tests/bind/messages-dynamic.json, without a database (docs/spec/feature-coverage.md
// FCV-3, FCV-4). Requirements: PRT-67.
#[Medium]
class BindMessagesDynamicRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'tests/bind/messages-dynamic.json';
    }

    /** The runtime name of the suite, which a case excludes by its exclude key. */
    protected static function runtime(): string
    {
        return 'php';
    }

    /** The cases this runtime runs: an excluded case is not registered as a test (Recipe::runnableCases). */
    public static function cases(): iterable
    {
        return Recipe::runnableCases(static::recipe(), static::runtime());
    }

    #[DataProvider('cases')]
    public function testNone(array $case): void
    {
        $this->runCase($case, Recipe::NONE);
    }
}
