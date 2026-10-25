<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Func;
use Polyspec\Orm\Model;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Registry;

final class ModelDslNativeTest extends TestCase
{
    public function testRelationMatchKeepsNamedKeysInTheRelationIr(): void
    {
        $hash = 'sha256:' . hash('sha256', DslFixture::MANIFEST);
        Registry::generated($hash, DslFixture::MANIFEST);
        Registry::register(DslFixture::class);
        $model = (new DslFixture())->matchIdWithId();
        $matches = (new \ReflectionProperty(Model::class, 'matches'))->getValue($model);

        self::assertSame([['left' => 'id', 'right' => 'id']], $matches);
    }

    public function testDynamicConditionsAndBuilderCallsReturnTheNativeModel(): void
    {
        // Requirements: INT-28 PLN-1 PLN-40.
        $model = new DslFixture();
        self::assertSame($model, $model->name('Ada')->orGtAge(20)->name(null));
        self::assertSame($model, $model->addColumnName()->groupByAge()->keyNameId()->newNote('memo'));
        self::assertSame('memo', $model->getNote());
        try {
            $model->getMissing();
            self::fail('A missing named row value must fail.');
        } catch (OrmException $error) {
            self::assertSame('CONFIG', $error->code_);
            self::assertSame(
                'CONFIG: ' . DslFixture::class . '::getMissing: the row has no value missing',
                $error->getMessage(),
            );
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

    // Requirements: DSL-50, PLN-4.
    public function testUnsupportedOperatorValuesAreRejectedInsteadOfConverted(): void
    {
        foreach ([
            [[18, 30], 'a list is not accepted by the gt operator'],
            [null, 'null is not accepted by the gt operator'],
        ] as [$value, $message]) {
            try {
                (new DslFixture())->gtAge($value);
                self::fail('The gt operator must not convert a list or null value.');
            } catch (OrmException $error) {
                self::assertSame('CONFIG', $error->code_);
                self::assertSame('CONFIG: ' . $message, $error->getMessage());
            }
        }
    }

    // Requirements: PLN-35.
    public function testGroupAndJoinCallbacksUseNativeInvocationPaths(): void
    {
        $model = new DslFixture();
        self::assertSame($model, $model->and(static fn(DslFixture $group) => $group->name('Ada')));
        self::assertSame($model, $model->on(static fn(DslFixture $group) => $group->age(20)));
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
