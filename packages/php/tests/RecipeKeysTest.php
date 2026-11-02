<?php

// The refusal unit test of the PHP recipe loader's key check (FCV-2 to FCV-4, T334-3-5-6): each unknown file, case, op
// or step key is refused by name, and a recipe whose keys the table holds is accepted.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
class RecipeKeysTest extends TestCase
{
    // A recipe at a path whose $schema is the recipe schema of this checkout, so the key table beside it is read.
    private const PATH = 'contracts/fixtures/model_writes/model_writes.json';
    private const SCHEMA = '../../../scripts/features/schema/recipe.schema.json';

    /** @param array<string, mixed> $file @param array<string, mixed> $case @param array<string, mixed>|null $step */
    private static function recipe(array $file = [], array $case = [], ?array $step = null): string
    {
        $step ??= ['op' => 'dsn.connect', 'dsn' => 'case'];
        return json_encode(
            ['$schema' => self::SCHEMA] + $file
                + ['cases' => [['id' => 'case-under-test', 'steps' => [$step]] + $case]],
            JSON_THROW_ON_ERROR
        );
    }

    public function testARecipeWhoseKeysTheTableHoldsIsAccepted(): void
    {
        RecipeKeys::check(self::PATH, self::recipe());
        $this->addToAssertionCount(1);
    }

    public function testAnUnknownFileKeyIsRefusedByName(): void
    {
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessageMatches('/unknown key bogus$/');
        RecipeKeys::check(self::PATH, self::recipe(['bogus' => 1]));
    }

    public function testAnUnknownCaseKeyIsRefusedByNameWithItsCase(): void
    {
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessageMatches('/case case-under-test: unknown key bogus$/');
        RecipeKeys::check(self::PATH, self::recipe([], ['bogus' => 1]));
    }

    public function testAnUnknownOpIsRefusedByNameWithItsStep(): void
    {
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessageMatches('/step 0: unknown op "no\.such\.op"$/');
        RecipeKeys::check(self::PATH, self::recipe([], [], ['op' => 'no.such.op']));
    }

    public function testAStepKeyAnotherOpHoldsIsRefusedOnTheOpThatDoesNotHoldIt(): void
    {
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessageMatches('/\(dsn\.connect\): unknown key pool_size$/');
        RecipeKeys::check(self::PATH, self::recipe([], [], ['op' => 'dsn.connect', 'dsn' => 'case', 'pool_size' => 2]));
    }

    public function testARecipeWithNoSchemaIsRefusedSinceItNamesNoKeyTable(): void
    {
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessageMatches('/no \$schema names the recipe key table/');
        RecipeKeys::check(self::PATH, json_encode(['cases' => []], JSON_THROW_ON_ERROR));
    }
}
