<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

// The collection recipe, tests/collection/collection.json, without a database (docs/spec/feature-coverage.md FCV-3,
// FCV-4): each case runs its collection.key steps, which take values through the public key of a collection
// (INT-11, INT-63, PRT-35).
// Requirements: INT-1, INT-11, INT-62, INT-63, INT-68, INT-69, INT-70, INT-71, INT-80, INT-81, INT-84, INT-86, INT-90,
// Requirements: PRT-35, PRT-69.
#[Medium]
class CollectionRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'tests/collection/collection.json';
    }

    #[DataProvider('cases')]
    public function testNone(string $id): void
    {
        $this->runCase($id, Recipe::NONE);
    }
}
