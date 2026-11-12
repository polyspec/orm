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
    private const SCHEMA = '../../../../scripts/features/schema/recipe.schema.json';

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

    public function testModelConnectOpensTheCaseDatabaseTheSocketOrTheText(): void
    {
        $case = 'mysql://root@127.0.0.1:3306/orm_case_17';
        $this->assertSame($case, Recipe::connectDsn(null, 'mysql', $case));
        $this->assertSame($case, Recipe::connectDsn('case', 'mysql', $case));
        $this->assertSame('sqlite://x', Recipe::connectDsn('sqlite://x', 'sqlite', $case));
        $this->assertSame(
            'mysql://root@localhost/orm_case_17?socket=/s/mysql.sock',
            Recipe::connectDsn('case-socket', 'mysql', $case, '/s/mysql.sock'),
        );
        $refused = [['postgres', '/s/mysql.sock', 'needs mysql'], ['mysql', '', 'is unset']];
        foreach ($refused as [$database, $socket, $text]) {
            try {
                Recipe::connectDsn('case-socket', $database, $case, $socket);
                $this->fail("case-socket on $database with socket '$socket' connected");
            } catch (\PHPUnit\Framework\AssertionFailedError $e) {
                $this->assertStringContainsString($text, $e->getMessage());
            }
        }
    }

    public function testAStepKeyThatTheRunDoesNotReadFailsByName(): void
    {
        $step = new RecipeStep(['op' => 'dsn.connect', 'dsn' => 'case', 'reason' => 'for the reader', 'bogus' => 1]);
        self::assertSame('case', $step['dsn']);
        try {
            $step->check();
            self::fail('the unread key passed');
        } catch (\PHPUnit\Framework\AssertionFailedError $failure) {
            self::assertSame('the helper did not read bogus of dsn.connect', $failure->getMessage());
        }
        self::assertSame(1, $step['bogus']);
        $step->check();
    }

    public function testAnOutcomeKeyThatTheRunDoesNotReadFailsByName(): void
    {
        $step = new RecipeStep(['op' => 'dsn.connect', 'expect' => ['none' => ['error' => 'X', 'bogus' => 1]]], 'none');
        self::assertSame('X', $step['expect']['none']['error']);
        $this->expectException(\PHPUnit\Framework\AssertionFailedError::class);
        $this->expectExceptionMessage('the helper did not read expect.bogus of dsn.connect');
        $step->check();
    }
}
