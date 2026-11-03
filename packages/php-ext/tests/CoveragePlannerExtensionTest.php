<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Engine;
use Polyspec\Orm\Planner;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Validator;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use ReflectionClass;

#[Small]
final class CoveragePlannerExtensionTest extends TestCase
{
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
}
