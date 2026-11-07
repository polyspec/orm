<?php

// Recipe conversion of the request hook: FCV-8, FCV-9, FCV-10,
// FCV-11, FCV-12, FCV-13, FCV-14 (docs/spec/feature-coverage.md).
// Requirements: INT-78, PRT-65.

// The request hook recipe, contracts/fixtures/request_hook/request_hook.json, on flowmark
// (docs/spec/feature-coverage.md FCV-3 and FCV-4).
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
class RequestHookMarkdownRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'contracts/fixtures/request_hook/request_hook.json';
    }

    #[DataProvider('casesOnMarkdown')]
    public function testMarkdown(string $id): void
    {
        $this->runCase($id, 'markdown');
    }
}
