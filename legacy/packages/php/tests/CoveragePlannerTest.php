<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// The invariants of the planner that the compile recipe tests/planner/compile.json (PlannerCompileTest.php) does not
// state.


use Polyspec\Orm\Dialect;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Planner;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Validator;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

/** The first step of the one case of tests/planner/compile.json under $root whose id is $id; another count fails the case. */
function plannerFixtureCase(string $root, string $id): array
{
    $recipe = coverageJson("$root/tests/planner/compile.json");
    $found = array_values(array_filter($recipe['cases'], static fn(array $case): bool => $case['id'] === $id));
    Assert::assertCount(1, $found, "planner compile recipe has " . count($found) . " cases $id");
    return $found[0]['steps'][0];
}

function plannerScalarColumnSubqueryRequest(string $root): array
{
    $case = plannerFixtureCase($root, 'planner_scalar_column_subquery');
    $model = RuntimeModel::build(RuntimeModel::files(["$root/tests/planner/{$case['schema']}"]));
    return [$model, ['manifest_hash' => $model->manifestHash] + $case['input']];
}

#[Small]
final class CoveragePlannerTest extends TestCase
{
    public static function setUpBeforeClass(): void
    {
        parent::setUpBeforeClass();
        require_once __DIR__ . '/ColumnFunctionMetadataAssertions.php';
    }

    /** @return array{RuntimeModel, array<string, mixed>} */
    private function scalarColumnSubqueryRequest(): array
    {
        return plannerScalarColumnSubqueryRequest(dirname(__DIR__, 3));
    }

    public function testScalarSubqueryMissingPostValidationColumnIsInternal(): void
    {
        [$model, $request] = $this->scalarColumnSubqueryRequest();
        (new \Polyspec\Orm\Validator($model))->validate($request);
        $request['columns']['sub']['first_author']['column'] = 'missing_column';
        try {
            (new Planner($model, new Dialect('sqlite')))->compile($request);
            Assert::fail('planner accepted a missing post-validation scalar subquery column');
        } catch (OrmException $error) {
            Assert::assertSame('INTERNAL', $error->code_);
            Assert::assertStringContainsString('author.missing_column', $error->getMessage());
        }
    }

    public function testColumnFunctionPlannerMissingPostValidationFieldIsInternal(): void
    {
        ColumnFunctionMetadataAssertions::assertPlannerMissingPostValidationFieldIsInternal();
    }

    public function testColumnFunctionParamUsesMissingPostValidationFieldIsInternal(): void
    {
        ColumnFunctionMetadataAssertions::assertParamUsesMissingPostValidationFieldIsInternal();
    }

    public function testColumnFunctionOutputMissingPostValidationFieldIsInternal(): void
    {
        ColumnFunctionMetadataAssertions::assertOutputMissingPostValidationFieldIsInternal();
    }
}
