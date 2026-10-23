<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Model;
use Polyspec\Orm\Code;
use Polyspec\Orm\OrmException;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

final class ModelWriteCallbackFixture extends Model
{
    public static function meta(): array
    {
        return [];
    }
}

final class ModelWriteAesFixture extends Model
{
    public static function meta(): array
    {
        $column = static fn(string $name): array => [
            'name' => $name,
            'codec' => ['aes'],
            'type' => 'text',
        ];
        return [
            'entity' => 'write_aes_fixture',
            'aes_version' => 'aes_key_version',
            'columns' => [
                'secret_a' => $column('secret_a'),
                'secret_b' => $column('secret_b'),
            ],
        ];
    }
}

#[Small]
final class ModelWriteSurfaceTest extends TestCase
{
    public function testNativeWriteHelpersAreInternalAndCallbacksOwnStandardPrivateState(): void
    {
        $model = new \ReflectionClass(Model::class);
        self::assertTrue($model->isInternal());
        self::assertSame('polyspec_orm', $model->getExtensionName());
        foreach (['encodeValue', 'create', 'creates', 'update', 'save', 'delete', 'deleteRow', 'restore', 'restoreOrCreate'] as $name) {
            $method = $model->getMethod($name);
            self::assertTrue($method->isInternal(), $name);
            self::assertSame('polyspec_orm', $method->getExtensionName(), $name);
        }

        $callbackClass = new \ReflectionClass(\Polyspec\Orm\ModelCreatesCallback::class);
        self::assertTrue($callbackClass->isInternal());
        self::assertTrue($callbackClass->isFinal());
        foreach ([
            \Polyspec\Orm\ModelCreatesCallback::class,
            \Polyspec\Orm\ModelRestoreHook::class,
            \Polyspec\Orm\ModelRestoreOrCreateCallback::class,
            \Polyspec\Orm\ModelDeleteCallback::class,
        ] as $class) {
            $reflection = new \ReflectionClass($class);
            self::assertTrue($reflection->isInternal(), $class);
            self::assertTrue($reflection->isFinal(), $class);
            $invoke = $reflection->getMethod('__invoke');
            self::assertTrue($invoke->isInternal(), $class . '::__invoke');
            self::assertSame('polyspec_orm', $invoke->getExtensionName(), $class . '::__invoke');
        }
        $capturedModel = new ModelWriteCallbackFixture();
        $callback = $callbackClass->newInstanceWithoutConstructor();
        foreach ([
            'model' => $capturedModel,
            'rows' => [],
            'columns' => [],
            'meta' => [],
            'parts' => [],
            'offset' => 0,
            'total' => 0,
        ] as $name => $value) {
            $property = $callbackClass->getProperty($name);
            self::assertTrue($property->isPrivate(), $name);
            $property->setValue($callback, $value);
        }

        $closure = \Closure::fromCallable($callback);
        self::assertNull($closure());
        self::assertSame(0, $callbackClass->getProperty('offset')->getValue($callback));
        self::assertSame(0, $callbackClass->getProperty('total')->getValue($callback));

        $second = $callbackClass->newInstanceWithoutConstructor();
        $callbackClass->getProperty('model')->setValue($second, $capturedModel);
        $callbackClass->getProperty('rows')->setValue($second, []);
        $callbackClass->getProperty('columns')->setValue($second, []);
        $callbackClass->getProperty('meta')->setValue($second, []);
        $callbackClass->getProperty('parts')->setValue($second, []);
        $callbackClass->getProperty('total')->setValue($second, 19);
        $secondClosure = \Closure::fromCallable($second);
        self::assertSame(
            $callbackClass->getProperty('model')->getValue($callback),
            $callbackClass->getProperty('model')->getValue($second),
        );
        self::assertNull($secondClosure());
        self::assertSame(0, $callbackClass->getProperty('total')->getValue($callback));
        self::assertSame(19, $callbackClass->getProperty('total')->getValue($second));

        $callbackClass->getProperty('parts')->setValue($callback, [0]);
        $throws = \Closure::fromCallable($callback);
        try {
            $throws();
            self::fail('invalid callback batch size must throw');
        } catch (\Throwable) {
            self::assertSame(0, $callbackClass->getProperty('total')->getValue($callback));
        }
        $callbackClass->getProperty('parts')->setValue($callback, []);

        $weakModel = \WeakReference::create($callbackClass->getProperty('model')->getValue($callback));
        unset($capturedModel);
        $fiberA = new \Fiber(static fn() => $secondClosure());
        $fiberB = new \Fiber(static fn() => $closure());
        $fiberA->start();
        $fiberB->start();
        self::assertSame(19, $callbackClass->getProperty('total')->getValue($second));
        self::assertSame(0, $callbackClass->getProperty('total')->getValue($callback));
        unset($fiberA, $fiberB, $throws, $closure, $secondClosure, $callback, $second);
        \gc_collect_cycles();
        self::assertNull($weakModel->get());
    }

    public function testNullableValuesDoNotCoerceIntoNonNullableWriteScalars(): void
    {
        $model = new ModelWriteCallbackFixture();
        foreach ([
            static fn() => $model->update(null),
            static fn() => $model->delete(null),
            static fn() => $model->deleteRow(null),
            static fn() => $model->creates([], null),
        ] as $call) {
            try {
                $call();
                self::fail('null must not coerce into a non-nullable native write argument');
            } catch (\TypeError) {
                self::assertTrue(true);
            }
        }
    }

    public function testAesExpansionKeepsTheModelSetsArrayUnchanged(): void
    {
        $model = new ModelWriteAesFixture();
        $base = new \ReflectionClass(Model::class);
        $sets = $base->getProperty('sets');
        $values = $base->getProperty('values');
        $row = $base->getProperty('row');
        $originalSets = ['secret_a' => ['value' => 'changed']];
        $sets->setValue($model, $originalSets);
        $values->setValue($model, ['secret_a' => 'changed', 'secret_b' => 'kept']);
        $row->setValue($model, [
            'loaded' => true,
            'names' => ['secret_a'],
            'hidden' => [],
            'original' => [],
            'extra' => [],
            'related' => [],
            'cascade' => [],
            'flat' => [],
        ]);
        $method = new \ReflectionMethod(Model::class, 'withAesColumns');
        $method->setAccessible(true);

        try {
            $method->invoke($model);
            self::fail('missing encrypted column must reject AES expansion');
        } catch (OrmException $error) {
            self::assertSame(Code::CONFIG, $error->code_);
        }
        self::assertSame($originalSets, $sets->getValue($model));

        $loadedRow = $row->getValue($model);
        $loadedRow['names'][] = 'secret_b';
        $row->setValue($model, $loadedRow);
        $expanded = $method->invoke($model);

        self::assertSame($originalSets, $sets->getValue($model));
        self::assertSame([
            'secret_a' => ['value' => 'changed'],
            'secret_b' => ['value' => 'kept'],
        ], $expanded);
    }
}
