<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// planner feature coverage: the param_uses cases in contracts/fixtures/planner.json, whose uses of each parameter are
// compared with the fixture. The compile cases are the recipe tests/planner/compile.json (PlannerCompileTest.php).


use Polyspec\Orm\Engine;
use Polyspec\Orm\Dialect;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Planner;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Validator;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\DataProvider;
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

/** @return iterable<string, array{string}> The planner fixture's exact named case ids. */
function plannerFixtureCases(string $root): iterable
{
    $fixture = coverageJson("$root/contracts/fixtures/planner.json");
    foreach ($fixture['cases'] as $case) {
        yield $case['id'] => [$case['id']];
    }
}

function plannerScalarColumnSubqueryRequest(string $root): array
{
    $case = plannerFixtureCase($root, 'planner_scalar_column_subquery');
    $model = RuntimeModel::build(RuntimeModel::files(["$root/tests/planner/{$case['schema']}"]));
    return [$model, ['manifest_hash' => $model->manifestHash] + $case['input']];
}

/** PRT-69: the scalar column subquery request with the aggregate $aggregate of $column, without its limit and order. */
function plannerScalarAggregateRequest(array $baseRequest, string $aggregate, string $column): array
{
    $request = $baseRequest;
    $request['columns']['sub']['first_author']['agg'] = $aggregate;
    $request['columns']['sub']['first_author']['column'] = $column;
    unset(
        $request['columns']['sub']['first_author']['query']['limit'],
        $request['columns']['sub']['first_author']['query']['order']
    );
    return $request;
}

/** Validates the request of a param_uses case and compares the uses of each parameter. */
function paramUsesCase(string $root, array $fixture, string $id): void
{
    $found = array_values(array_filter($fixture['cases'], static fn(array $c): bool => $c['id'] === $id));
    Assert::assertTrue(count($found) === 1, "planner.json has " . count($found) . " cases $id");
    $case = $found[0];
    Assert::assertTrue($case['operation'] === 'param_uses', "case $id has operation {$case['operation']}");
    $model = RuntimeModel::build(RuntimeModel::files(["$root/{$case['schema']}"]));
    $request = ['manifest_hash' => $model->manifestHash] + $case['input'];
    $validator = new Validator($model);
    $validator->validate($request);
    // key is the fixture's sorted key order.
    $uses = array_map(static fn(array $list): array => array_map(static fn(array $u): array => $u['column'] === null
        ? ['type' => $u['type']]
        : ($u['assign'] ? ['assign' => true] : []) + [
            'column' => $u['column']['name'],
            'length' => $u['column']['length'] ?? 0,
            'null' => $u['column']['nullable'],
            'precision' => $u['column']['precision'] ?? 0,
            'scale' => $u['column']['scale'] ?? 0,
            'type' => $u['type'],
        ], $list), $validator->paramUses($request));
    Assert::assertTrue($uses === $case['expected']['uses'], "$id param uses " . json_encode($uses));
}

#[Small]
final class CoveragePlannerTest extends TestCase
{
    /** @return iterable<string, array{string}> */
    public static function vectorCases(): iterable
    {
        return plannerFixtureCases(dirname(__DIR__, 3));
    }

    #[DataProvider('vectorCases')]
    public function testVector(string $id): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        paramUsesCase($root, $fixture, $id);
    }

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

    public function testFunctionAndSubqueryCannotReuseAnOutputName(): void
    {
        [$model, $request] = $this->scalarColumnSubqueryRequest();
        $request['entity'] = 'author';
        $request['columns']['fn']['first_author'] = ['column' => 'created_ts', 'fn' => ['name' => 'year']];

        try {
            (new Engine($model, 'sqlite', 8))->compile($request);
            Assert::fail('planner accepted a function and subquery with the same output name');
        } catch (OrmException $error) {
            Assert::assertSame('COLUMN_ALIAS_CONFLICT', $error->code_);
            Assert::assertSame(
                'COLUMN_ALIAS_CONFLICT: author.first_author is already a row name',
                $error->getMessage()
            );
        }
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

    // Requirements: PRT-69.
    public function testScalarSubqueryAggregateTypesRemainI64AndF64(): void
    {
        [$model, $baseRequest] = $this->scalarColumnSubqueryRequest();
        foreach ([['count', '', 'i64'], ['avg', 'read_count', 'f64']] as [$aggregate, $column, $expected]) {
            $request = plannerScalarAggregateRequest($baseRequest, $aggregate, $column);
            (new \Polyspec\Orm\Validator($model))->validate($request);
            $plan = (new Planner($model, new Dialect('sqlite')))->compile($request);
            $output = array_values(array_filter(
                $plan['steps'][0]['assemble']['columns'],
                static fn(array $col): bool => $col['name'] === 'first_author'
            ))[0];
            Assert::assertSame($expected, $output['type'], "$aggregate output type");
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

    // Requirements: DIA-31, PRT-67.
    public function testParamUsesColumnFunction(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        paramUsesCase($root, $fixture, 'param_uses_column_function');
    }

    // Requirements: DIA-31, PRT-67.
    public function testParamUsesInterval(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        paramUsesCase($root, $fixture, 'param_uses_interval');
    }

    // Requirements: DIA-31, PRT-67.
    public function testParamUsesContains(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        paramUsesCase($root, $fixture, 'param_uses_contains');
    }

    // Requirements: DIA-31, PRT-67.
    public function testParamUsesIfParent(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        paramUsesCase($root, $fixture, 'param_uses_if_parent');
    }

    // Requirements: DIA-31, PRT-67.
    public function testParamUsesOptimistic(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        paramUsesCase($root, $fixture, 'param_uses_optimistic');
    }

    // Requirements: DSL-95.
}
