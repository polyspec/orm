<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
final class BlindIndexSourcePlannerTest extends TestCase
{
    use BlindIndexSourcePlannerInput;

    // Requirements: COD-4.
    public function testMultiRowIndexUsesTheAssignedSourceColumnPosition(): void
    {
        $this->assertMultiRowIndexUsesTheAssignedSourcePosition();
    }

    // Requirements: COD-4.
    public function testOrdinaryInsertControlHasNoBlindIndexSlots(): void
    {
        $this->assertOrdinaryInsertHasNoBlindIndexSlots();
    }

    // Requirements: COD-4.
    public function testTwoNullSourcesDerivingOneTargetAreInvalid(): void
    {
        $this->assertSourcesConflict([
            ['column' => 'email_a', 'null' => true],
            ['column' => 'email_b', 'null' => true],
        ], 2);
    }

    // Requirements: COD-4.
    public function testEqualParameterSourcesDerivingOneTargetAreInvalid(): void
    {
        $this->assertSourcesConflict([
            $this->assignment('email_a', 2),
            $this->assignment('email_b', 2),
        ], 3);
    }

    // Requirements: COD-4.
    public function testExplicitTargetAssignmentWinsForSharedSchema(): void
    {
        $this->assertExplicitTargetAssignmentWins();
    }

    // Requirements: COD-4.
    public function testOnDuplicateRejectsTwoSourcesIndependently(): void
    {
        $this->assertOnDuplicateRejectsTwoSourcesIndependently();
    }

    // Requirements: COD-4.
    public function testExplicitTargetWinsInOnDuplicate(): void
    {
        $this->assertExplicitTargetWinsInOnDuplicate();
    }
}
