<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Engine;
use Polyspec\Orm\Planner;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Validator;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use ReflectionClass;

#[Small]
final class CoveragePlannerExtensionTest extends TestCase
{
    /** @return iterable<string, array{string}> */
    public static function vectorCases(): iterable
    {
        require_once dirname(__DIR__, 2) . '/php/tests/CoveragePlannerTest.php';
        return plannerFixtureCases(dirname(__DIR__, 3));
    }

    #[DataProvider('vectorCases')]
    public function testVector(string $id): void
    {
        $this->runPlannerCoverageCase($id);
    }

    private function runPlannerCoverageCase(string $id): void
    {
        require_once dirname(__DIR__, 2) . '/php/tests/CoveragePlannerTest.php';
        Assert::assertTrue((new ReflectionClass(Planner::class))->isInternal());
        Assert::assertTrue((new ReflectionClass(Validator::class))->isInternal());

        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        paramUsesCase($root, $fixture, $id);
    }

    // Requirements: PRT-78.
    // Requirements: PRT-69.
    public function testPlannerScalarSubqueryAggregateTypesRemainI64AndF64(): void
    {
        require_once dirname(__DIR__, 2) . '/php/tests/CoveragePlannerTest.php';
        Assert::assertTrue((new ReflectionClass(Engine::class))->isInternal());
        Assert::assertTrue((new ReflectionClass(Planner::class))->isInternal());
        Assert::assertTrue((new ReflectionClass(Validator::class))->isInternal());

        [$model, $baseRequest] = plannerScalarColumnSubqueryRequest(dirname(__DIR__, 3));
        foreach ([['count', '', 'i64'], ['avg', 'read_count', 'f64']] as [$aggregate, $column, $expected]) {
            $request = plannerScalarAggregateRequest($baseRequest, $aggregate, $column);
            (new Validator($model))->validate($request);
            $plan = (new Engine($model, 'sqlite', 8))->plan($request);
            $output = array_values(array_filter(
                $plan['steps'][0]['assemble']['columns'],
                static fn(array $col): bool => $col['name'] === 'first_author'
            ));
            Assert::assertCount(1, $output, "$aggregate output metadata");
            Assert::assertSame($expected, $output[0]['type'], "$aggregate output type");
        }
    }

    // Requirements: DIA-31, PRT-67.
    public function testParamUsesColumnFunction(): void
    {
        $this->runPlannerCoverageCase('param_uses_column_function');
    }

    // Requirements: DIA-31, PRT-67.
    public function testParamUsesInterval(): void
    {
        $this->runPlannerCoverageCase('param_uses_interval');
    }

    // Requirements: DIA-31, PRT-67.
    public function testParamUsesContains(): void
    {
        $this->runPlannerCoverageCase('param_uses_contains');
    }

    // Requirements: DIA-31, PRT-67.
    public function testParamUsesIfParent(): void
    {
        $this->runPlannerCoverageCase('param_uses_if_parent');
    }

    // Requirements: DIA-31, PRT-67.
    public function testParamUsesOptimistic(): void
    {
        $this->runPlannerCoverageCase('param_uses_optimistic');
    }
}
