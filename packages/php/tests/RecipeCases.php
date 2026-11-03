<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

/** The cases of the recipe of a test class, and the run of one case on one database (Recipe::NONE for none). */
trait RecipeCases
{
    /** The path of the recipe, relative to the root of the checkout. */
    abstract protected static function recipe(): string;

    /** @return iterable<string, array{array<string, mixed>}> */
    public static function cases(): iterable
    {
        return Recipe::cases(static::recipe());
    }

    /** @param array<string, mixed> $case */
    private function runCase(array $case, string $database): void
    {
        $this->addToAssertionCount(1);
        Recipe::run(static::recipe(), $case, $database);
        Recipe::report($case, $database);
    }
}
