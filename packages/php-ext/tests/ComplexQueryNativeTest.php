<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
final class ComplexQueryNativeTest extends TestCase
{
    public function testProductSearchFulltextNamesUseNativeModelAndChain(): void
    {
        ComplexQueryDbCase::assertFulltextChains(true);
    }

    // Requirements: CPX-2.
    public function testProductSearchPageUsesNativePlannerAndModels(): void
    {
        ComplexQueryDbCase::run(true);
    }
}
