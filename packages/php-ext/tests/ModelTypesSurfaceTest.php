<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\TestCase;
use Polyspec\Orm\CanonicalRequest;
use Polyspec\Orm\Code;
use Polyspec\Orm\Func;
use Polyspec\Orm\Model;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Page;
use Polyspec\Orm\PendingTime;
use Polyspec\Orm\Request;
use Polyspec\Orm\StyledValue;
use Polyspec\Orm\Tests\ModelTypesWeakCallerCases;

final class ModelTypesSurfaceTest extends TestCase
{
    use ModelTypesWeakCallerCases;

    /** @return array{0: mixed, 1: list<string>} */
    private static function captureWarnings(callable $call): array
    {
        $warnings = [];
        set_error_handler(static function (int $severity, string $message) use (&$warnings): bool {
            $warnings[] = $message;
            return true;
        });
        try {
            return [$call(), $warnings];
        } finally {
            restore_error_handler();
        }
    }

    private static function userlandPadIn(array $values): array
    {
        $count = count($values);
        // The bit length of n - 1 equals ceil(log2(n)); this avoids the native doubling loop.
        $exponent = $count <= 1 ? 0 : strlen(decbin($count - 1));
        // Counts above this exponent cannot have a representable positive PHP integer bucket.
        $bucketSize = $exponent >= PHP_INT_SIZE * 8 - 1 ? 0 : 1 << $exponent;
        while (count($values) < $bucketSize) {
            $values[] = $values[count($values) - 1];
        }
        return $values;
    }

    public function testTheThreeHelperTypesAreNativeAndHaveThePhpSurface(): void
    {
        foreach ([Request::class, StyledValue::class, Page::class] as $class) {
            $reflection = new \ReflectionClass($class);
            self::assertTrue($reflection->isInternal(), "$class must be registered by polyspec_orm");
            self::assertTrue($reflection->isFinal());
        }

        self::assertSame(
            ['__construct', 'param', 'padIn', 'canonicalize', 'shape'],
            array_map(
                static fn (\ReflectionMethod $method): string => $method->getName(),
                (new \ReflectionClass(Request::class))->getMethods(),
            ),
        );
        $requestReflection = new \ReflectionClass(Request::class);
        self::assertSame(
            ['ir', 'params', 'names', 'external', 'canonical'],
            array_map(
                static fn (\ReflectionProperty $property): string => $property->getName(),
                $requestReflection->getProperties(),
            ),
        );
        self::assertSame(
            ['params', 'names', 'external', 'canonical'],
            array_keys($requestReflection->getDefaultProperties()),
        );
        foreach (['ir', 'params', 'names', 'external'] as $name) {
            self::assertSame('array', $requestReflection->getProperty($name)->getType()->getName());
        }
        self::assertSame('bool', $requestReflection->getProperty('canonical')->getType()->getName());
        self::assertSame(
            ['__construct', 'sqlNull', 'value', 'payload', 'jsonSerialize'],
            array_map(
                static fn (\ReflectionMethod $method): string => $method->getName(),
                (new \ReflectionClass(StyledValue::class))->getMethods(),
            ),
        );
        $styledReflection = new \ReflectionClass(StyledValue::class);
        self::assertTrue($styledReflection->isReadOnly());
        self::assertSame(
            ['kind', 'payload'],
            array_map(
                static fn (\ReflectionProperty $property): string => $property->getName(),
                $styledReflection->getProperties(),
            ),
        );
        self::assertSame('string', $styledReflection->getProperty('kind')->getType()->getName());
        self::assertTrue($styledReflection->getProperty('kind')->isPublic());
        self::assertTrue($styledReflection->getProperty('kind')->isReadOnly());
        self::assertTrue($styledReflection->getProperty('payload')->isPrivate());
        self::assertTrue($styledReflection->getProperty('payload')->isReadOnly());
        self::assertTrue($styledReflection->getMethod('__construct')->isPrivate());
        self::assertSame(
            ['__construct'],
            array_map(
                static fn (\ReflectionMethod $method): string => $method->getName(),
                (new \ReflectionClass(Page::class))->getMethods(),
            ),
        );
        $pageReflection = new \ReflectionClass(Page::class);
        self::assertTrue($pageReflection->isReadOnly());
        self::assertSame(
            ['items', 'totalCount', 'totalPages', 'page', 'perPage'],
            array_map(
                static fn (\ReflectionProperty $property): string => $property->getName(),
                $pageReflection->getProperties(),
            ),
        );
        self::assertSame('Polyspec\\Orm\\Collection', $pageReflection->getProperty('items')->getType()->getName());
        foreach (['totalCount', 'totalPages', 'page', 'perPage'] as $name) {
            self::assertSame('int', $pageReflection->getProperty($name)->getType()->getName());
            self::assertTrue($pageReflection->getProperty($name)->isReadOnly());
        }
    }

    public function testTypedParametersAndPropertiesRetainTheStrictPhpSurface(): void
    {
        $request = new \ReflectionClass(Request::class);
        self::assertSame(['kind', 'manifestHash'], array_map(
            static fn(\ReflectionParameter $parameter): string => $parameter->getName(),
            $request->getConstructor()->getParameters()
        ));
        self::assertSame('string', $request->getConstructor()->getParameters()[0]->getType()->getName());
        self::assertSame('mixed', $request->getMethod('param')->getParameters()[0]->getType()->getName());
        self::assertSame('array', $request->getMethod('padIn')->getParameters()[0]->getType()->getName());

        try {
            Request::padIn('not-an-array');
            self::fail('array parameter accepted a string in a strict caller');
        } catch (\TypeError) {
            self::assertTrue(true);
        }
        $requestObject = new Request('read', 'manifest');
        try {
            $requestObject->params = 'not-an-array';
            self::fail('typed params property accepted a string');
        } catch (\TypeError) {
            self::assertSame([], $requestObject->params);
        }
        try {
            new Page(new \Polyspec\Orm\Collection(), '0', 0, 1, 20);
            self::fail('strict integer constructor parameter accepted text');
        } catch (\TypeError) {
            self::assertTrue(true);
        }
    }

    public function testRequestCanonicalizationMatchesThePhpCanonicalRequestAlgorithm(): void
    {
        $request = new Request('read', 'manifest');
        $request->params = ['unused', 7, 'seven', 9, 11, 'tail'];
        $request->ir = [
            'ir_version' => 1,
            'manifest_hash' => 'manifest',
            'kind' => 'read',
            'entity' => 'probe',
            'where' => ['op' => 'in', 'ps' => [1, 2, 3, 4, 5]],
            'joins' => [['where' => ['p' => 0, 'plus_p' => 2]]],
            'rows' => [[4, 1]],
            'optimistic' => ['minus_p' => 3],
        ];
        [$expectedIr, $expectedParams] = CanonicalRequest::of($request->ir, $request->params);

        $request->canonicalize();
        self::assertSame($expectedIr, $request->ir);
        self::assertSame($expectedParams, $request->params);
        self::assertTrue($request->canonical);
        $onceIr = $request->ir;
        $onceParams = $request->params;
        $request->canonicalize();
        self::assertSame($onceIr, $request->ir, 'canonicalization is idempotent');
        self::assertSame($onceParams, $request->params, 'canonicalization keeps parameter values and order');
        self::assertSame($request->ir + ['n_params' => count($request->params)], $request->shape());
    }

    public function testPadInMatchesUserlandForBucketSizesSparseAndStringKeys(): void
    {
        // These vectors are independent of both the userland oracle and native implementation.
        // Padding targets the least power of two >= input length and repeats the last value.
        foreach (
            [
                [[10], [10]],
                [[10, 11], [10, 11]],
                [[10, 11, 12], [10, 11, 12, 12]],
                [[10, 11, 12, 13], [10, 11, 12, 13]],
                [[10, 11, 12, 13, 14], [10, 11, 12, 13, 14, 14, 14, 14]],
                [[10, 11, 12, 13, 14, 15], [10, 11, 12, 13, 14, 15, 15, 15]],
                [[10, 11, 12, 13, 14, 15, 16, 17], [10, 11, 12, 13, 14, 15, 16, 17]],
            ] as [$input, $expected]
        ) {
            self::assertSame($expected, self::userlandPadIn($input), 'independent userland pad vector');
            self::assertSame($expected, Request::padIn($input), 'native pad vector');
        }

        $inputs = [
            [],
            [10],
            [10, 11],
            [10, 11, 12],
            [10, 11, 12, 13],
            [10, 11, 12, 13, 14],
            [10, 11, 12, 13, 14, 15],
            [10, 11, 12, 13, 14, 15, 16, 17],
            [5 => 'left', 9 => 'right'],
            ['alpha' => 'left', 'omega' => 'right'],
            [0 => 'zero', 3 => 'three', 7 => 'seven'],
            ['first' => 'one', 'second' => 'two', 'third' => 'three'],
        ];
        foreach ($inputs as $input) {
            self::assertSame(
                self::captureWarnings(static fn () => self::userlandPadIn($input)),
                self::captureWarnings(static fn () => Request::padIn($input)),
                'padIn must preserve PHP array keys and warning behavior for ' . var_export($input, true)
            );
        }
    }

    public function testPadInWarningExceptionDoesNotChangeInput(): void
    {
        $values = [0 => 'first', 3 => 'last', 4 => 'tail'];
        $before = $values;
        $expected = new \ErrorException('warning promoted by handler');
        set_error_handler(static function () use ($expected): never {
            throw $expected;
        });
        try {
            Request::padIn($values);
            self::fail('undefined-key warning was not propagated');
        } catch (\ErrorException $actual) {
            self::assertSame($expected, $actual);
        } finally {
            restore_error_handler();
        }
        self::assertSame($before, $values);
    }

    public function testRequestInvalidIndexUsesTheExistingCodeAndDoesNotPartiallyMutate(): void
    {
        $request = new Request('read', 'manifest');
        $request->params = ['kept'];
        $request->ir = ['where' => ['p' => 3]];
        try {
            $request->canonicalize();
            self::fail('out-of-range parameter reference was accepted');
        } catch (OrmException $error) {
            self::assertSame(Code::IR_INVALID, $error->code_);
            self::assertSame(
                'param index 3 out of range (n_params 1)',
                substr($error->getMessage(), strlen(Code::IR_INVALID) + 2),
            );
        }
        self::assertSame(['where' => ['p' => 3]], $request->ir);
        self::assertSame(['kept'], $request->params);
        self::assertFalse($request->canonical);
    }

    public function testStyledValueMatchesNullValueSerializationAndExceptionBehavior(): void
    {
        $null = StyledValue::sqlNull();
        self::assertSame('sql-null', $null->kind);
        self::assertSame(['kind' => 'sql-null'], $null->jsonSerialize());
        self::assertSame('{"kind":"sql-null"}', json_encode($null, JSON_THROW_ON_ERROR));
        try {
            $null->payload();
            self::fail('SQL NULL has no payload');
        } catch (OrmException $error) {
            self::assertSame(Code::CODEC_DECODE, $error->code_);
            self::assertSame(
                'SQL NULL has no styled value',
                substr($error->getMessage(), strlen(Code::CODEC_DECODE) + 2),
            );
        }

        $value = StyledValue::value(['answer' => 42]);
        self::assertSame('value', $value->kind);
        self::assertSame(['answer' => 42], $value->payload());
        self::assertSame(['kind' => 'value', 'value' => ['answer' => 42]], $value->jsonSerialize());
        self::assertEquals($value, unserialize(serialize($value), ['allowed_classes' => true]));
        self::assertEquals($value, clone $value);
        try {
            $value->kind = 'sql-null';
            self::fail('readonly kind changed');
        } catch (\Error) {
            self::assertSame('value', $value->kind);
        }
    }

    public function testPageKeepsCollectionIdentityReadonlyFieldsAndSerialization(): void
    {
        $items = new \Polyspec\Orm\Collection();
        $page = new Page($items, 0, 0, 1, 20);
        self::assertSame($items, $page->items);
        self::assertSame([0, 0, 1, 20], [$page->totalCount, $page->totalPages, $page->page, $page->perPage]);
        self::assertEquals($page, unserialize(serialize($page), ['allowed_classes' => true]));
        try {
            $page->page = 2;
            self::fail('readonly page field changed');
        } catch (\Error) {
            self::assertSame(1, $page->page);
        }
    }

    public function testRequestPropertiesParticipateInCloneSerializationAndCycleCollection(): void
    {
        $request = new Request('read', 'manifest');
        $object = new \stdClass();
        self::assertSame(0, $request->param($object));
        self::assertSame($object, $request->params[0]);
        $copy = clone $request;
        self::assertSame($request->ir, $copy->ir);
        self::assertEquals($request, unserialize(serialize($request), ['allowed_classes' => true]));

        $cycle = new Request('read', 'cycle');
        $cycle->external[] = $cycle;
        $weak = \WeakReference::create($cycle);
        unset($cycle);
        gc_collect_cycles();
        self::assertNull($weak->get(), 'declared property arrays must be visible to Zend GC');
    }

    public function testFuncPreservesCallbackArgumentsOrderShapeAndExceptionIdentity(): void
    {
        foreach ([Func::class, PendingTime::class] as $class) {
            self::assertTrue((new \ReflectionClass($class))->isInternal());
        }
        $first = new \stdClass();
        $func = new Func('date_add', [$first, '3 days'], false);
        $seen = [];
        $ir = $func->ir(static function (mixed $value) use (&$seen): int {
            $seen[] = $value;
            return count($seen) - 1;
        });
        self::assertSame(['name' => 'date_add', 'ps' => [0, 1]], $ir);
        self::assertSame([$first, '3 days'], $seen);
        self::assertSame($first, $seen[0]);

        $empty = new Func('now', [], true);
        self::assertSame(['name' => 'now'], $empty->ir(static fn (mixed $value): int => 99));

        $expected = new \RuntimeException('callback failed');
        try {
            $func->ir(static function () use ($expected): never {
                throw $expected;
            });
            self::fail('callback exception was swallowed or replaced');
        } catch (\RuntimeException $actual) {
            self::assertSame($expected, $actual);
        }
        self::assertEquals($func, unserialize(serialize($func), ['allowed_classes' => true]));
        self::assertEquals($func, clone $func);
        try {
            $func->extra = true;
            self::fail('readonly function accepted a dynamic property');
        } catch (\Error) {
            self::assertSame('date_add', $func->name);
        }
    }

    public function testPendingTimePreservesUnparsedTextAndTimezoneIdentity(): void
    {
        $zone = new \DateTimeZone('Pacific/Chatham');
        $time = new PendingTime('2031-06-07 08:09:10.123456', $zone);
        self::assertSame($time->text, '2031-06-07 08:09:10.123456');
        self::assertSame($zone, $time->zone);
        $reflection = new \ReflectionClass(PendingTime::class);
        self::assertSame(
            ['text', 'zone'],
            array_map(
                static fn (\ReflectionProperty $property): string => $property->getName(),
                $reflection->getProperties(),
            ),
        );
        self::assertSame('string', $reflection->getProperty('text')->getType()->getName());
        self::assertSame(\DateTimeZone::class, $reflection->getProperty('zone')->getType()->getName());
        self::assertTrue($reflection->getProperty('text')->isReadOnly());
        self::assertTrue($reflection->getProperty('zone')->isReadOnly());
        try {
            $time->text = 'changed';
            self::fail('readonly deferred text changed');
        } catch (\Error) {
            self::assertSame('2031-06-07 08:09:10.123456', $time->text);
        }
        self::assertEquals($time, unserialize(serialize($time), ['allowed_classes' => true]));
    }

    public function testNativeModelResolvesPendingTimeValues(): void
    {
        $resolve = new \ReflectionMethod(Model::class, 'resolved');
        $model = new ModelTypesPendingFixture();
        $zone = new \DateTimeZone('UTC');
        $resolved = $resolve->invoke($model, new PendingTime('2031-06-07 08:09:10', $zone));
        self::assertInstanceOf(\DateTimeImmutable::class, $resolved);
        self::assertSame('2031-06-07T08:09:10+00:00', $resolved->format('Y-m-d\TH:i:sP'));

        try {
            $resolve->invoke($model, new PendingTime('not a date', $zone));
            self::fail('an invalid pending time must be rejected');
        } catch (OrmException $error) {
            self::assertSame(Code::CODEC_DECODE, $error->code_);
        }
    }
}
