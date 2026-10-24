<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Collection;
use Polyspec\Orm\Db;
use Polyspec\Orm\GroupRow;
use Polyspec\Orm\GroupRows;
use Polyspec\Orm\Model;
use Polyspec\Orm\OrmException;

#[Small]
final class GroupRowsTest extends TestCase
{
    public function testOwner(): void
    {
        foreach ([Collection::class, GroupRows::class] as $class) {
            $method = new \ReflectionMethod($class, 'toArray');
            self::assertTrue($method->isPublic(), "$class::toArray is not public");
            self::assertSame([], $method->getParameters(), "$class::toArray accepts arguments");
            self::assertSame('array', $method->getReturnType()?->getName(), "$class::toArray return type changed");
            self::assertSame(
                $class,
                $method->getDeclaringClass()->getName(),
                "$class::toArray is not declared on the class"
            );
        }
        $row = new GroupRow([['is_close', false], ['row_count', 3]]);
        self::assertSame(3, $row->count(), 'group result lost its count');
        self::assertFalse($row->value('is_close'), 'group result lost a selected value');
        self::assertSame(['is_close' => false, 'row_count' => 3], $row->toArray());
        try {
            $row->value('name');
            self::fail('unselected group value was accepted');
        } catch (OrmException $error) {
            self::assertSame(Code::COLUMN_UNSELECTED, $error->code_);
        }
        $rows = new GroupRows([$row]);
        self::assertCount(1, $rows, 'group result collection changed the row');
        self::assertSame(
            [['is_close' => false, 'row_count' => 3]],
            $rows->toArray(),
            'group result collection changed the row'
        );
        foreach (
            [
            [['is_close', false]],
            [['row_count', true]],
            [['row_count', -1]],
            [['row_count', 1.5]],
            [['row_count', '900719925474099300000']],
            [['row_count', 1], ['row_count', 2]],
            [['row_count', 1, 'extra']],
            ] as $invalid
        ) {
            try {
                new GroupRow($invalid);
                self::fail('invalid group count was accepted: ' . json_encode($invalid));
            } catch (OrmException $error) {
                self::assertContains($error->code_, [Code::CODEC_DECODE, Code::INTERNAL, Code::CONFIG]);
            }
        }
    }

    // PRT-36: the production group result decoder rejects an invalid stored boolean.
    public function testGroupBooleanRejectsInvalidStoredValue(): void
    {
        $model = new class extends Model {
            public static function meta(): array
            {
                return ['entity' => 'group_boolean_fixture'];
            }
        };
        $db = (new \ReflectionClass(Db::class))->newInstanceWithoutConstructor();
        $groupValue = new \ReflectionMethod(Model::class, 'groupValue');
        try {
            $groupValue->invoke($model, $db, ['name' => 'active', 'column' => '', 'type' => 'bool'], 'invalid');
            self::fail('invalid boolean group value was accepted');
        } catch (OrmException $error) {
            self::assertSame(Code::CODEC_DECODE, $error->code_);
            self::assertSame('CODEC_DECODE: group column active is not boolean', $error->getMessage());
        }
    }

    public function testGroupResultPreservesExactI64Value(): void
    {
        $model = new class extends Model {
            public static function meta(): array
            {
                return ['entity' => 'group_i64_fixture'];
            }
        };
        $db = (new \ReflectionClass(Db::class))->newInstanceWithoutConstructor();
        $groupValue = new \ReflectionMethod(Model::class, 'groupValue');
        $want = 9007199254740991;
        $value = $groupValue->invoke($model, $db, ['name' => 'exact_value', 'column' => '', 'type' => 'i64'], $want);
        self::assertSame($want, $value);
        $row = new GroupRow([['exact_value', $value], ['row_count', 1]]);
        self::assertSame($want, $row->value('exact_value'));
        self::assertSame(['exact_value' => $want, 'row_count' => 1], $row->toArray());
    }

    // Requirements: INT-90.
    public function testNegativeCountIsCodecDecode(): void
    {
        foreach ([-1, '-1', -1.5] as $count) {
            try {
                new GroupRow([['row_count', $count]]);
                self::fail('negative group count was accepted: ' . json_encode($count));
            } catch (OrmException $error) {
                self::assertSame(Code::CODEC_DECODE, $error->code_);
            }
        }
    }

    public function testGroupRowCountEnforcesExactness(): void
    {
        foreach ([true, 1.5, -1, 9007199254740992, 9007199254740992.0, '9007199254740992'] as $invalid) {
            try {
                new GroupRow([['row_count', $invalid]]);
                self::fail('invalid row_count was accepted: ' . var_export($invalid, true));
            } catch (OrmException $error) {
                self::assertSame(Code::CODEC_DECODE, $error->code_);
            }
        }
        try {
            new GroupRow([['selected', 'x']]);
            self::fail('missing row_count was accepted');
        } catch (OrmException $error) {
            self::assertSame(Code::INTERNAL, $error->code_);
        }
        $validCounts = [[0, 0], ['0', 0], [9007199254740991, 9007199254740991], ['9007199254740991', 9007199254740991]];
        foreach ($validCounts as [$input, $want]) {
            $row = new GroupRow([['row_count', $input]]);
            self::assertSame($want, $row->count());
            self::assertSame($want, $row->toArray()['row_count']);
        }
    }
}
