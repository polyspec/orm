<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

// The session recipe, tests/markdown/session.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4): each
// markdown.session step runs reads of the bind fixture model on a listener that answers from its replies.
// Requirements: PRT-66.
#[Medium]
class MarkdownSessionRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'tests/markdown/session.json';
    }

    #[DataProvider('cases')]
    public function testNone(string $id): void
    {
        $this->runCase($id, Recipe::NONE);
    }
}
