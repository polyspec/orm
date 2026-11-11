<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

/** The cases of the recipe of a test class, and the run of one case on one database (Recipe::NONE for none). */
trait RecipeCases
{
    /** The path of the recipe, relative to the root of the checkout. */
    abstract protected static function recipe(): string;

    /**
     * The data set of each case holds its id, not the case: PHPUnit keeps a data set for each test it builds, whatever
     * the filter of the run.
     *
     * @return array<string, array{string}>
     */
    public static function cases(): array
    {
        return Recipe::cases(static::recipe());
    }

    /** @return array<string, array{string}> */
    public static function casesOnMysql(): array
    {
        return Recipe::casesOn(static::recipe(), 'mysql');
    }

    /** @return array<string, array{string}> */
    public static function casesOnPostgres(): array
    {
        return Recipe::casesOn(static::recipe(), 'postgres');
    }

    /** @return array<string, array{string}> */
    public static function casesOnSqlite(): array
    {
        return Recipe::casesOn(static::recipe(), 'sqlite');
    }

    /** @return array<string, array{0: string}> the cases of the recipe on flowmark, as a data provider (FCV-3) */
    public static function casesOnMarkdown(): array
    {
        return Recipe::casesOn(static::recipe(), 'markdown');
    }

    /**
     * The cases that run on MariaDB, a server of the MySQL dialect: those that run on MySQL (DIA-200, FCV-3).
     *
     * @return array<string, array{string}>
     */
    public static function casesOnMariadb(): array
    {
        return Recipe::casesOn(static::recipe(), 'mariadb');
    }

    /** Makes room for the memory that the recipe of the test class declares it needs (memory_budget.php). */
    private static function requireMemoryLimit(string $budget): void
    {
        requireMemoryBudget($budget, 'the recipe ' . static::recipe());
    }

    private function runCase(string $id, string $database): void
    {
        $this->addToAssertionCount(1);
        $recipe = static::recipe();
        $case = Recipe::caseOf($recipe, $id);
        Recipe::run($recipe, $case, $database);
        Recipe::report($case, $database);
    }
}
