<?php

// The codec recipe, tests/codec/codec.json, without a database (docs/spec/feature-coverage.md FCV-3).
// Requirements: COD-3, COD-4, COD-5, COD-8, COD-9, COD-10, COD-11, COD-12, COD-13, COD-14, COD-16, COD-20, COD-28,
// COD-29, COD-30, COD-31, COD-33, COD-34, COD-35, COD-36, COD-37, COD-38, COD-39, COD-40, PLN-15.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
class CodecRecipeTest extends TestCase
{
    private const RECIPE = 'tests/codec/codec.json';

    /** @return iterable<string, array{array<string, mixed>}> */
    public static function cases(): iterable
    {
        return Recipe::cases(self::RECIPE);
    }

    #[DataProvider('cases')]
    public function testNone(array $case): void
    {
        $this->addToAssertionCount(1);
        Recipe::run(self::RECIPE, $case, Recipe::NONE);
    }
}
