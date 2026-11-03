<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
final class ComplexQueryDbTest extends TestCase
{
    // Requirements: DSL-159.
    public function testGetPagePlanStepsGivesTheStepsOfThePlanOfGetsPage(): void
    {
        ComplexQueryDbCase::assertPagePlanSteps(false);
    }
}
