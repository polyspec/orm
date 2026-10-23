<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Func;
use Polyspec\Orm\Model;
use Polyspec\Orm\OrmException;

final class DslFixture extends Model
{
    public static function meta(): array
    {
        return ['entity' => 'dsl_fixture', 'manifest_hash' => 'sha256:dsl', 'columns' => [
            'id' => ['type' => 'i64', 'codec' => [], 'nullable' => false],
            'name' => ['type' => 'text', 'codec' => [], 'nullable' => true],
            'age' => ['type' => 'i32', 'codec' => [], 'nullable' => true],
        ], 'indexes' => ['by_name' => ['name']]];
    }
}

final class ModelDslNativeTest extends TestCase
{
    public function testDynamicConditionsAndBuilderCallsReturnTheNativeModel(): void
    {
        $model = new DslFixture();
        self::assertSame($model, $model->name('Ada')->orGtAge(20)->name(null));
        self::assertSame($model, $model->addColumnName()->groupByAge()->keyNameId()->newNote('memo'));
        self::assertSame('memo', $model->getNote());
        try {
            $model->getMissing();
            self::fail('A missing named row value must fail.');
        } catch (OrmException $error) {
            self::assertSame('CONFIG', $error->code_);
            self::assertSame('CONFIG: ' . DslFixture::class . '::getMissing: the row has no value missing', $error->getMessage());
        }
    }

    public function testConditionArityAndNullabilityUseSourceErrors(): void
    {
        try {
            (new DslFixture())->name();
            self::fail('Missing condition argument should fail.');
        } catch (OrmException $error) {
            self::assertSame('CONFIG', $error->code_);
            self::assertSame('CONFIG: the condition expects 1 values', $error->getMessage());
        }
        try {
            (new DslFixture())->id(null);
            self::fail('A non-nullable column must reject null.');
        } catch (OrmException $error) {
            self::assertSame('CONFIG', $error->code_);
            self::assertSame('CONFIG: dsl_fixture.id is not nullable', $error->getMessage());
        }
    }

    public function testBetweenUsesAListAndColumnFunctionConsumesOneComparedValue(): void
    {
        $model = new DslFixture();
        self::assertSame($model, $model->betweenAge([18, 30])->age(new Func('abs', [], true), 24));

        try {
            (new DslFixture())->betweenAge(18, 30);
            self::fail('Between bounds are passed as one two-value list.');
        } catch (OrmException $error) {
            self::assertSame('CONFIG', $error->code_);
            self::assertSame('CONFIG: between value for age must be a two-value array', $error->getMessage());
        }
        try {
            (new DslFixture())->age(new Func('abs', [], true), 18, 24);
            self::fail('A column function accepts exactly one compared value.');
        } catch (OrmException $error) {
            self::assertSame('CONFIG', $error->code_);
            self::assertSame('CONFIG: column function on age requires one compared value', $error->getMessage());
        }
    }

    public function testEmptyListUsesTheDeclaredEmptyInError(): void
    {
        try {
            (new DslFixture())->name([]);
            self::fail('An empty IN list should fail.');
        } catch (OrmException $error) {
            self::assertSame('EMPTY_IN', $error->code_);
            self::assertSame('EMPTY_IN: name received an empty list', $error->getMessage());
        }
    }
}
