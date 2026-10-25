<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Model;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Request;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
final class ModelWriteSurfaceTest extends TestCase
{
    private static function callbackFixture(): Model
    {
        return new class extends Model {
            public static function meta(): array
            {
                return [];
            }
        };
    }

    private static function aesFixture(): Model
    {
        return new class extends Model {
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
        };
    }

    public function testNativeKeyValuesReadsTheModelMetadata(): void
    {
        $model = new class extends Model {
            public static function meta(): array
            {
                return ['entity' => 'ModelKeyValuesFixture', 'columns' => [], 'pk' => ['id']];
            }
        };
        $sets = (new \ReflectionClass(Model::class))->getProperty('sets');
        $sets->setValue($model, ['id' => ['value' => 42]]);

        $keyValues = new \ReflectionMethod(Model::class, 'keyValues');
        self::assertSame(['id' => 42], $keyValues->invoke($model));
    }

    public function testNativeUpdateClearsAnIncompleteKeyBeforeThrowingConfig(): void
    {
        $db = new \Polyspec\Orm\Db(
            new \PDO('sqlite::memory:'),
            'sqlite',
            new Config(),
            new \DateTimeZone('UTC')
        );
        try {
            $error = null;
            try {
                (new \Polyspec\Orm\Tests\Model\CompositeAccount())($db)
                    ->setName('missing key')
                    ->update();
            } catch (OrmException $caught) {
                $error = $caught;
            }
            self::assertSame(Code::CONFIG, $error?->code_);
            self::assertSame(
                'CONFIG: composite_account requires a loaded row or set primary key tenant_id',
                $error?->getMessage()
            );
        } finally {
            $db->close();
        }
    }

    public function testNativeMarkdownWriteReturnsFirstKeyOrNullWhenNoKeysWereAnswered(): void
    {
        $manifestHash = \Polyspec\Orm\Tests\MarkdownModel\People::meta()['manifest_hash'];
        foreach (
            [
            ['{"affected":1,"keys":["P1","P2"]}', ['P1', 1]],
            ['{"affected":0,"keys":[]}', [null, 0]],
            ] as [$answer, $expected]
        ) {
            $server = \Polyspec\Orm\Tests\start_markdown_test_server(['{"ok":true}', $answer]);
            try {
                $db = \Polyspec\Orm\Tests\MarkdownModel\connect($server[2], new Config());
            } catch (\Throwable $error) {
                // A refused connect leaves the fake server waiting for a request; it is stopped so that it does not
                // hold the output of the run open.
                proc_terminate($server[0]);
                fclose($server[1]);
                fclose($server[3]);
                proc_close($server[0]);
                throw $error;
            }
            try {
                $request = new Request('insert', $manifestHash);
                $request->ir['entity'] = 'people';
                $request->ir['set'][] = ['column' => 'name', 'p' => $request->param('Ann')];
                self::assertSame($expected, $db->writeOf(null, $request));
            } finally {
                $db->close();
            }
            $messages = \Polyspec\Orm\Tests\markdown_test_server_received_messages($server);
            self::assertCount(2, $messages);
            self::assertSame(\Polyspec\Orm\Tests\MARKDOWN_CONNECT_LINE, $messages[0]);
            self::assertStringContainsString('"request"', $messages[1]);
        }
    }

    public function testNativeWriteHelpersAreInternalAndCallbacksOwnStandardPrivateState(): void
    {
        $model = new \ReflectionClass(Model::class);
        self::assertTrue($model->isInternal());
        self::assertSame('polyspec_orm', $model->getExtensionName());
        foreach (
            [
            'encodeValue',
            'create',
            'creates',
            'update',
            'save',
            'delete',
            'deleteRow',
            'restore',
            'restoreOrCreate',
            ] as $name
        ) {
            $method = $model->getMethod($name);
            self::assertTrue($method->isInternal(), $name);
            self::assertSame('polyspec_orm', $method->getExtensionName(), $name);
        }

        $callbackClass = new \ReflectionClass(\Polyspec\Orm\ModelCreatesCallback::class);
        self::assertTrue($callbackClass->isInternal());
        self::assertTrue($callbackClass->isFinal());
        foreach (
            [
            \Polyspec\Orm\ModelCreatesCallback::class,
            \Polyspec\Orm\ModelRestoreHook::class,
            \Polyspec\Orm\ModelRestoreOrCreateCallback::class,
            \Polyspec\Orm\ModelDeleteCallback::class,
            ] as $class
        ) {
            $reflection = new \ReflectionClass($class);
            self::assertTrue($reflection->isInternal(), $class);
            self::assertTrue($reflection->isFinal(), $class);
            $invoke = $reflection->getMethod('__invoke');
            self::assertTrue($invoke->isInternal(), $class . '::__invoke');
            self::assertSame('polyspec_orm', $invoke->getExtensionName(), $class . '::__invoke');
        }
        $capturedModel = self::callbackFixture();
        $callback = $callbackClass->newInstanceWithoutConstructor();
        foreach (
            [
            'model' => $capturedModel,
            'rows' => [],
            'columns' => [],
            'meta' => [],
            'parts' => [],
            'offset' => 0,
            'total' => 0,
            ] as $name => $value
        ) {
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
        $model = self::callbackFixture();
        foreach (
            [
            static fn() => $model->update(null),
            static fn() => $model->delete(null),
            static fn() => $model->deleteRow(null),
            static fn() => $model->creates([], null),
            ] as $call
        ) {
            try {
                $call();
                self::fail('null must not coerce into a non-nullable native write argument');
            } catch (\TypeError) {
                self::assertTrue(true);
            }
        }
    }

    public function testTransactionalWriteCallbacksPreserveMissingConnectionError(): void
    {
        $model = self::callbackFixture();
        foreach (
            [
                static fn() => $model->restoreOrCreate(),
                static fn() => $model->delete(true),
            ] as $call
        ) {
            try {
                $call();
                self::fail('transactional callback without a connection must throw');
            } catch (OrmException $error) {
                self::assertSame(Code::CONFIG, $error->code_);
                self::assertSame(
                    'CONFIG: the model has no connection; use connect or run it inside a transaction',
                    $error->getMessage(),
                );
            }
        }
    }

    public function testBuildAndWriteRequestRejectNullableKinds(): void
    {
        $model = self::callbackFixture();
        $build = new \ReflectionMethod(Model::class, 'build');
        $writeRequest = new \ReflectionMethod(Model::class, 'writeRequest');
        foreach (
            [
                static fn() => $build->invoke($model, null, new \stdClass()),
                static fn() => $writeRequest->invoke($model, null, new \stdClass()),
            ] as $call
        ) {
            try {
                $call();
                self::fail('build and writeRequest require a non-null kind');
            } catch (\TypeError) {
                self::assertTrue(true);
            }
        }
    }

    public function testAesExpansionKeepsTheModelSetsArrayUnchanged(): void
    {
        $model = self::aesFixture();
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
