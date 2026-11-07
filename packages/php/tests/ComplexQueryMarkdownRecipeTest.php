<?php

// The complex_query recipe, contracts/fixtures/complex_query/complex_query.json, on
// markdown (docs/spec/feature-coverage.md FCV-3 and FCV-4).
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
class ComplexQueryMarkdownRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'contracts/fixtures/complex_query/complex_query.json';
    }

    #[DataProvider('casesOnMarkdown')]
    public function testMarkdown(string $id): void
    {
        $this->runCase($id, 'markdown');
    }
}
