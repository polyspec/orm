<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Engine;
use Polyspec\Orm\Planner;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Validator;
use ReflectionClass;

#[Small]
final class BlindIndexSourceNativeTest extends TestCase
{
    use BlindIndexSourcePlannerInput;

    public static function setUpBeforeClass(): void
    {
        Assert::assertTrue((new ReflectionClass(Engine::class))->isInternal());
        Assert::assertTrue((new ReflectionClass(Planner::class))->isInternal());
        Assert::assertTrue((new ReflectionClass(Validator::class))->isInternal());
    }

    // Requirements: COD-4.
    public function testNativeMultiRowIndexUsesAssignedSourcePosition(): void
    {
        $engine = $this->engine();
        $plan = $engine->compile($this->request($engine, [
            $this->assignment('id', 0),
            $this->assignment('name', 1),
            $this->assignment('email_b', 2),
        ], 6, ['rows' => [[3, 4, 5]]]));
        $params = [];
        foreach ($plan['steps'][0]['bind_slots'] as $slot) {
            if (in_array('blind_index', $slot['host_styles'] ?? [], true)) {
                $params[] = $slot['param'];
            }
        }
        Assert::assertSame([2, 5], $params);
    }

    // Requirements: COD-4.
    public function testNativeOrdinaryInsertHasNoBlindIndexSlots(): void
    {
        $engine = $this->engine();
        $plan = $engine->compile($this->request($engine, [
            $this->assignment('id', 0),
            $this->assignment('name', 1),
        ], 2));
        foreach ($plan['steps'][0]['bind_slots'] as $slot) {
            Assert::assertNotContains('blind_index', $slot['host_styles'] ?? []);
        }
    }

    // Requirements: COD-4.
    public function testNativeTwoNullSourcesDerivingOneTargetAreInvalid(): void
    {
        $this->assertSourcesConflict([
            ['column' => 'email_a', 'null' => true],
            ['column' => 'email_b', 'null' => true],
        ], 2);
    }

    // Requirements: COD-4.
    public function testNativeEqualParameterSourcesDerivingOneTargetAreInvalid(): void
    {
        $this->assertSourcesConflict([
            $this->assignment('email_a', 2),
            $this->assignment('email_b', 2),
        ], 3);
    }

    // Requirements: COD-4.
    public function testNativeExplicitTargetAssignmentWinsForSharedSchema(): void
    {
        $engine = $this->engine();
        $plan = $engine->compile($this->request($engine, [
            $this->assignment('id', 0),
            $this->assignment('name', 1),
            $this->assignment('email_a', 2),
            $this->assignment('email_b', 3),
            $this->assignment('hash', 4),
        ], 5));
        Assert::assertSame(1, substr_count($plan['steps'][0]['sql'], '`hash`'));
    }

    // Requirements: COD-4.
    public function testNativeOnDuplicateRejectsTwoSourcesIndependently(): void
    {
        $engine = $this->engine();
        $cases = [
            [[$this->assignment('email_a', 2), $this->assignment('email_b', 3)], 4],
            [[$this->assignment('email_a', 2), $this->assignment('email_b', 2)], 3],
            [[['column' => 'email_a', 'null' => true], ['column' => 'email_b', 'null' => true]], 2],
        ];
        foreach ($cases as [$sources, $nParams]) {
            $request = $this->request($engine, [
                $this->assignment('id', 0),
                $this->assignment('name', 1),
            ], $nParams, ['on_duplicate' => $sources]);
            $this->assertSourceConflict($engine, $request);
        }
    }

    // Requirements: COD-4.
    public function testNativeExplicitTargetWinsInOnDuplicate(): void
    {
        $plan = $this->compileBaseInsert(5, [
            'on_duplicate' => [
                $this->assignment('email_a', 2),
                $this->assignment('email_b', 3),
                $this->assignment('hash', 4),
            ],
        ]);
        Assert::assertSame(1, substr_count($plan['steps'][0]['sql'], '`hash`'));
    }
}
