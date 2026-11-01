<?php

// The Mermaid recipe, tests/dbspec/mermaid.json, without a database (docs/spec/feature-coverage.md FCV-3).
// Requirements: MER-1, MER-2, MER-3, MER-4, MER-5, MER-6, MER-7, MER-8, MER-9, MER-10, MER-11, MER-12, MER-13.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
class DbspecMermaidRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'tests/dbspec/mermaid.json';
    }

    #[DataProvider('cases')]
    public function testNone(array $case): void
    {
        $this->runCase($case, Recipe::NONE);
    }
}
