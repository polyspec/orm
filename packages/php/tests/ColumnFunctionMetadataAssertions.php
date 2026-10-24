<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use Polyspec\Orm\Dialect;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Planner;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Validator;

final class ColumnFunctionMetadataAssertions
{
    /** @return array{RuntimeModel, array} */
    private static function fixture(): array
    {
        $root = dirname(__DIR__, 3);
        $fixture = json_decode(
            (string) file_get_contents("$root/contracts/fixtures/planner.json"),
            true,
            512,
            JSON_THROW_ON_ERROR
        );
        $cases = array_values(array_filter(
            $fixture['cases'],
            static fn(array $case): bool => $case['id'] === 'planner_column_function_date'
        ));
        Assert::assertCount(1, $cases, 'planner fixture has exactly one date column-function case');
        $case = $cases[0];
        return [RuntimeModel::build(RuntimeModel::files(["$root/{$case['schema']}"])), $case['input']];
    }

    /** @return array{RuntimeModel, Validator, array<string, mixed>} */
    private static function validatedRequest(): array
    {
        [$model, $input] = self::fixture();
        $validator = new Validator($model);
        $request = ['manifest_hash' => $model->manifestHash] + $input;
        $validator->validate($request);
        return [$model, $validator, $request];
    }

    public static function assertPlannerMissingPostValidationFieldIsInternal(): void
    {
        [$model, $validator, $request] = self::validatedRequest();
        Assert::assertSame('date', $validator->paramUses($request)[0][0]['type']);
        (new Planner($model, new Dialect('sqlite')))->compile($request);

        $publicInvalid = $request;
        $publicInvalid['where']['items'][0]['pred']['column'] = 'missing_column';
        try {
            $validator->validate($publicInvalid);
            Assert::fail('public validation accepted an unknown column');
        } catch (OrmException $error) {
            Assert::assertSame('COLUMN_UNKNOWN', $error->code_);
        }

        $request['where']['items'][0]['pred']['column'] = 'missing_column';
        foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
            try {
                (new Planner($model, new Dialect($dialect)))->compile($request);
                Assert::fail("$dialect planner accepted missing post-validation column-function metadata");
            } catch (OrmException $error) {
                Assert::assertSame('INTERNAL', $error->code_);
                Assert::assertStringContainsString('author.missing_column', $error->getMessage());
            }
        }
    }

    public static function assertParamUsesMissingPostValidationFieldIsInternal(): void
    {
        [$model, $validator, $request] = self::validatedRequest();
        Assert::assertSame('date', $validator->paramUses($request)[0][0]['type']);
        $request['where']['items'][0]['pred']['column'] = 'missing_column';
        try {
            $validator->paramUses($request);
            Assert::fail('parameter-use collection accepted missing post-validation column-function metadata');
        } catch (OrmException $error) {
            Assert::assertSame('INTERNAL', $error->code_);
            Assert::assertStringContainsString('author.missing_column', $error->getMessage());
        }
    }
    public static function assertOutputMissingPostValidationFieldIsInternal(): void
    {
        [$model] = self::fixture();
        $validator = new Validator($model);
        $selected = [
            'ir_version' => 1,
            'manifest_hash' => $model->manifestHash,
            'kind' => 'all',
            'n_params' => 0,
            'entity' => 'author',
            'columns' => ['mode' => 'none', 'fn' => [
                'selected_year' => ['column' => 'start_dt', 'fn' => ['name' => 'year']],
            ]],
        ];
        $validator->validate($selected);
        $validPlan = (new Planner($model, new Dialect('sqlite')))->compile($selected);
        $selectedYear = array_values(array_filter(
            $validPlan['steps'][0]['assemble']['columns'],
            static fn(array $column): bool => $column['name'] === 'selected_year'
        ))[0];
        Assert::assertSame('i64', $selectedYear['type']);

        $selected['columns']['fn']['selected_year']['column'] = 'missing_column';
        try {
            (new Planner($model, new Dialect('sqlite')))->compile($selected);
            Assert::fail('planner accepted a missing post-validation output column-function field');
        } catch (OrmException $error) {
            Assert::assertSame('INTERNAL', $error->code_);
            Assert::assertStringContainsString('author.missing_column', $error->getMessage());
        }
    }
}
