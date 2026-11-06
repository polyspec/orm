<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The test class of a recipe that runs on SQLite (docs/spec/feature-coverage.md FCV-3): a recipe test extends it and
 * names its recipe, and every case runs on SQLite and flowmark as testSqlite and testMarkdown; a markdown connection
 * runs the cases that SQLite runs (DIA-154).
 */
abstract class SqliteRecipeTestCase extends TestCase
{
    use RecipeCases;

    #[DataProvider('casesOnSqlite')]
    public function testSqlite(string $id): void
    {
        $this->runCase($id, 'sqlite');
    }

    #[DataProvider('casesOnMarkdown')]
    public function testMarkdown(string $id): void
    {
        $this->runCase($id, 'markdown');
    }
}
