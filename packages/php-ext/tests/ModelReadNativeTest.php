<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Db;
use Polyspec\Orm\GroupRow;
use Polyspec\Orm\GroupRows;
use Polyspec\Orm\Model;
use Polyspec\Orm\OrmException;

#[Small]
final class ModelReadNativeTest extends TestCase
{
    public function testReadMethodsAreNativeExtensionEntries(): void
    {
        foreach (['get', 'gets', 'getsCount', 'getCount', 'getSum', 'getAvg', 'getsPage'] as $name) {
            self::assertTrue((new \ReflectionMethod(Model::class, $name))->isInternal(), $name);
        }
    }

    public function testRowShapeGroupsDeclaredColumnsAndRetainsHiddenAndKeyMetadata(): void
    {
        $model = new ModelReadShapeFixture();
        $method = new \ReflectionMethod(Model::class, 'rowShape');
        $shape = $method->invoke($model, [
            'node' => 0,
            'columns' => [
                ['index' => 0, 'name' => 'id', 'column' => 'id', 'hidden' => false],
                ['index' => 1, 'name' => 'active', 'column' => 'active', 'hidden' => false],
                ['index' => 2, 'name' => 'payload', 'column' => 'payload', 'hidden' => true],
                ['index' => 3, 'name' => 'updated_ts', 'column' => 'updated_ts', 'hidden' => false],
            ],
            'key' => [['index' => 0]],
        ]);
        self::assertSame([[0, 'id', 'i64']], $shape['int']);
        self::assertSame([[1, 'active', 'bool']], $shape['bool']);
        self::assertSame([[2, 'payload', 'codec']], $shape['codec']);
        self::assertSame(['payload' => true], $shape['hidden']);
        self::assertSame(['id', 'updated_ts'], $shape['original']);
        self::assertSame(0, $shape['key']);
        self::assertSame([], $shape['row']['related']);
    }

    public function testNativeNumericReadersRejectLossyValuesAndCheckBounds(): void
    {
        $integer = new \ReflectionMethod(Model::class, 'groupInteger');
        self::assertSame(-32768, $integer->invoke(null, '-32768', 'i16', 'rank'));
        try {
            $integer->invoke(null, '32768', 'i16', 'rank');
            self::fail('An out-of-range i16 must fail.');
        } catch (OrmException $error) {
            self::assertSame(Code::CODEC_DECODE, $error->code_);
        }
        try {
            $integer->invoke(null, '01', 'i32', 'rank');
            self::fail('A noncanonical integer must fail.');
        } catch (OrmException $error) {
            self::assertSame(Code::CODEC_DECODE, $error->code_);
        }

        $float = new \ReflectionMethod(Model::class, 'groupFloat');
        self::assertSame(1.25e2, $float->invoke(null, '1.25e2', 'ratio'));
        try {
            $float->invoke(null, '1e9999', 'ratio');
            self::fail('A nonfinite float must fail.');
        } catch (OrmException $error) {
            self::assertSame(Code::CODEC_DECODE, $error->code_);
            self::assertStringContainsString('not finite', $error->getMessage());
        }

        $number = new \ReflectionMethod(Model::class, 'aggregateNumber');
        self::assertSame(1.25e2, $number->invoke(null, '1.25e2'));
        try {
            $number->invoke(null, '1.2x');
            self::fail('Trailing text must fail numeric conversion.');
        } catch (OrmException $error) {
            self::assertSame(Code::CODEC_DECODE, $error->code_);
        }
        try {
            $number->invoke(null, '1e9999');
            self::fail('An out-of-range aggregate must fail.');
        } catch (OrmException $error) {
            self::assertStringContainsString('outside finite binary64 range', $error->getMessage());
        }
    }

    public function testNativeRowAssemblyRejectsNonFiniteFloatCells(): void
    {
        $assembly = ModelAssemblyTestSupport::uninitializedAssembly();
        $model = new ModelReadShapeFixture();
        $assembleRow = new \ReflectionMethod(Model::class, 'assembleRow');
        // The output name is supplied by the result declaration; static metadata omits it.
        foreach (['ratio', 'row_count'] as $offset => $name) {
            $declaration = [
                'node' => 10 + $offset,
                'key' => [],
                'children' => [],
                'columns' => [['index' => 0, 'name' => $name, 'column' => $name, 'hidden' => false]],
            ];
            $valid = $assembleRow->invoke($model, $assembly, $declaration, [1.25]);
            self::assertSame(1.25, (new \ReflectionProperty(Model::class, 'values'))->getValue($valid)[$name]);

            foreach ([NAN, 'NaN'] as $raw) {
                try {
                    $assembleRow->invoke($model, $assembly, $declaration, [$raw]);
                    self::fail("A non-finite $name float cell must fail decoding.");
                } catch (OrmException $error) {
                    self::assertSame(Code::CODEC_DECODE, $error->code_);
                }
            }
        }
    }

    public function testCompositeRelationKeysUseLengthPrefixedScalarText(): void
    {
        $method = new \ReflectionMethod(Model::class, 'matchKey');
        self::assertSame('2:ab1:c', $method->invoke(null, ['ab', 'c']));
        self::assertSame('same', $method->invoke(null, ['same']));
    }

    public function testJoinAndRelationChildLookupsMatchResultNames(): void
    {
        $parent = new ModelReadShapeFixture();
        $child = new ModelReadShapeFixture();
        (new \ReflectionProperty(Model::class, 'joins'))->setValue($parent, [['child' => $child]]);
        (new \ReflectionProperty(Model::class, 'relations'))->setValue($parent, [['many' => true, 'child' => $child]]);

        self::assertSame(
            $child,
            (new \ReflectionMethod(Model::class, 'joinChild'))->invoke($parent, 'read_shape_model'),
        );
        self::assertSame(
            [$child, true],
            (new \ReflectionMethod(Model::class, 'relationChild'))->invoke($parent, 'read_shape_models'),
        );
    }

    public function testCollectionKeyUsesTheNativeFetchKeyCallback(): void
    {
        $model = new ModelReadShapeFixture();
        $model->fetchKey(static fn(Model $row): string => 'parent-' . $row::meta()['entity']);
        $method = new \ReflectionMethod(Model::class, 'collectionKey');
        self::assertSame('parent-read_shape', $method->invoke($model, $model, ['key' => []], []));
    }

    // Requirements: PRT-69, INT-90.
    public function testGroupBooleanIsStrictAndRowCountStaysRawForGroupRowValidation(): void
    {
        $db = (new \ReflectionClass(Db::class))->newInstanceWithoutConstructor();
        $groupValue = new \ReflectionMethod(Model::class, 'groupValue');
        self::assertTrue($groupValue->invoke(
            new ModelReadShapeFixture(),
            $db,
            ['name' => 'active', 'column' => 'active', 'type' => 'bool'],
            'true'
        ));
        foreach ([false, true] as $native) {
            self::assertSame($native, $groupValue->invoke(
                new ModelReadShapeFixture(),
                $db,
                ['name' => 'active', 'column' => 'active', 'type' => 'bool'],
                $native
            ));
        }
        self::assertSame('5', $groupValue->invoke(
            new ModelReadShapeFixture(),
            $db,
            ['name' => 'row_count', 'type' => 'i64'],
            '5'
        ));
        try {
            $groupValue->invoke(
                new ModelReadShapeFixture(),
                $db,
                ['name' => 'active', 'column' => 'active', 'type' => 'bool'],
                'yes'
            );
            self::fail('An invalid grouped boolean must fail.');
        } catch (OrmException $error) {
            self::assertSame(Code::CODEC_DECODE, $error->code_);
            self::assertSame('CODEC_DECODE: group column active is not boolean', $error->getMessage());
        }
    }

    public function testNativeRowStreamReadFailurePreservesThrowableAndDoesNotMutateBuilder(): void
    {
        $assembly = ModelAssemblyTestSupport::uninitializedAssembly();
        $model = new ModelReadShapeFixture();
        $assembleRow = new \ReflectionMethod(Model::class, 'assembleRow');
        $declaration = [
            'node' => 9,
            'key' => [],
            'children' => [],
            'columns' => [['index' => 0, 'name' => 'title', 'column' => 'title', 'hidden' => false]],
        ];
        self::assertTrue(stream_wrapper_register('ormnativewarning', ModelReadWarningStream::class));
        $stream = fopen('ormnativewarning://source', 'r');
        self::assertIsResource($stream);
        $warning = new \ErrorException('original stream warning');
        set_error_handler(static fn() => throw $warning);
        try {
            try {
                $assembleRow->invoke($model, $assembly, $declaration, [$stream]);
                self::fail('The warning handler Throwable must escape unchanged.');
            } catch (\Throwable $actual) {
                self::assertSame($warning, $actual);
            }
        } finally {
            restore_error_handler();
            fclose($stream);
            stream_wrapper_unregister('ormnativewarning');
        }
        self::assertSame([], (new \ReflectionProperty(Model::class, 'values'))->getValue($model));
        self::assertNull((new \ReflectionProperty(Model::class, 'row'))->getValue($model));
    }

    public function testGroupRowsRetainCheckedCountAndSelectedValues(): void
    {
        $row = new GroupRow([['active', false], ['row_count', '2']]);
        self::assertSame(2, $row->count());
        self::assertFalse($row->value('active'));
        self::assertSame([['active' => false, 'row_count' => 2]], (new GroupRows([$row]))->toArray());
        try {
            $row->value('missing');
            self::fail('An unselected group value must fail.');
        } catch (OrmException $error) {
            self::assertSame(Code::COLUMN_UNSELECTED, $error->code_);
        }
    }
}
