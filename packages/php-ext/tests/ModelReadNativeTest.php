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
    use \Polyspec\Orm\Tests\DatabaseTestAssertions;

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
        // COD-1: a refused cell names its entity and column and the rule of its type, never the value.
        $cell = new \ReflectionMethod(Model::class, 'cellValue');
        $zone = new \DateTimeZone('UTC');
        $i16 = ['type' => 'i16'];
        self::assertSame(-32768, $cell->invoke(null, 'read_shape', 'rank', $i16, '-32768', false, true, $zone));
        foreach (['32768', '01'] as $raw) {
            try {
                $cell->invoke(null, 'read_shape', 'rank', $i16, $raw, false, true, $zone);
                self::fail('An out-of-range or noncanonical i16 must fail.');
            } catch (OrmException $error) {
                self::assertSame(
                    'CODEC_DECODE: read_shape.rank: i16 cell is not an exact integer in its range',
                    $error->getMessage()
                );
            }
        }
        $f64 = ['type' => 'f64'];
        self::assertSame(1.25e2, $cell->invoke(null, 'read_shape', 'ratio', $f64, '1.25e2', false, true, $zone));
        try {
            $cell->invoke(null, 'read_shape', 'ratio', $f64, '1e9999', false, true, $zone);
            self::fail('A nonfinite float must fail.');
        } catch (OrmException $error) {
            self::assertSame('CODEC_DECODE: read_shape.ratio: f64 cell is not a finite number', $error->getMessage());
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
            self::assertSame(Code::CODEC_DECODE, $error->code_);
            self::assertSame('CODEC_DECODE: aggregate scalar is not a finite number', $error->getMessage());
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

            $this->assertNonFiniteFloatCellDecodesAsError(
                static fn(mixed $raw): mixed => $assembleRow->invoke(
                    $model,
                    $assembly,
                    $declaration,
                    [$raw]
                ),
                "A non-finite $name float cell"
            );
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
    // Requirements: INT-68, INT-90.
    public function testGroupBooleanIsStrictAndRowCountStaysRawForGroupRowValidation(): void
    {
        $db = new Db(new \PDO('sqlite::memory:'), 'sqlite', new \Polyspec\Orm\Config(), new \DateTimeZone('UTC'));
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
            self::assertSame('CODEC_DECODE: read_shape.active: bool cell is not boolean', $error->getMessage());
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
