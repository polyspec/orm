<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
final class ComplexQueryDbTest extends TestCase
{
    public function testProductSearchFulltextNamesBuildFromGeneratedModels(): void
    {
        ComplexQueryDbCase::assertFulltextChains(false);
    }

    // Requirements: CPX-2.
    public function testProductSearchPage(): void
    {
        ComplexQueryDbCase::run(false);
    }
}
