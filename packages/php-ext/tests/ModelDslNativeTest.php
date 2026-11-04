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

    public function testConditionArityUsesSourceErrors(): void
    {
        try {
            (new DslFixture())->name()->getCount();
            self::fail('Missing condition argument should fail.');
        } catch (OrmException $error) {
            self::assertSame('CONFIG', $error->code_);
            self::assertSame('CONFIG: the condition expects 1 values', $error->getMessage());
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
            (new DslFixture())->betweenAge(18, 30)->getCount();
            self::fail('Between bounds are passed as one two-value list.');
        } catch (OrmException $error) {
            self::assertSame('CONFIG', $error->code_);
            self::assertSame('CONFIG: between value for age must be a two-value array', $error->getMessage());
        }
        try {
            (new DslFixture())->age(new Func('abs', [], true), 18, 24)->getCount();
            self::fail('A column function accepts exactly one compared value.');
        } catch (OrmException $error) {
            self::assertSame('CONFIG', $error->code_);
            self::assertSame('CONFIG: column function on age requires one compared value', $error->getMessage());
        }
    }
}
