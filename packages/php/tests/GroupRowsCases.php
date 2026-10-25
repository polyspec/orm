<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Code;
use Polyspec\Orm\Db;
use Polyspec\Orm\GroupRow;
use Polyspec\Orm\Model;
use Polyspec\Orm\OrmException;

/** Shared group-result behavior checks for the PHP library and extension. */
trait GroupRowsCases
{
    protected function assertGroupRowOwnership(): void
    {
    }

    protected function assertGroupValueOwnership(): void
    {
    }

    protected function assertGroupRowCountError(OrmException $error): void
    {
    }

    public function testGroupRowPreservesTypedValuesAndChecksItsCount(): void
    {
        $this->assertGroupRowOwnership();
        $row = new GroupRow([
            ['active', false],
            ['optional', null],
            ['large', '9223372036854775807'],
            ['row_count', '3'],
        ]);

        self::assertSame(3, $row->count());
        self::assertSame(false, $row->value('active'));
        self::assertNull($row->value('optional'));
        self::assertSame('9223372036854775807', $row->value('large'));
        self::assertSame(3, $row->toArray()['row_count']);
        self::assertSame($row->toArray(), $row->jsonSerialize());
        self::assertSame($row->toArray(), (clone $row)->toArray());
        self::assertSame($row->toArray(), unserialize(serialize($row))->toArray());

        try {
            $row->value('missing');
            self::fail('an unselected group value was accepted');
        } catch (OrmException $error) {
            self::assertSame(Code::COLUMN_UNSELECTED, $error->code_);
            self::assertSame('COLUMN_UNSELECTED: group column missing was not selected', $error->getMessage());
        }

        foreach (
            [
                [[['name', 'value']]],
                [[['row_count', 1], ['row_count', 2]]],
                [[['', 'value'], ['row_count', 1]]],
            ] as $entries
        ) {
            try {
                new GroupRow($entries[0]);
                self::fail('malformed group entries were accepted');
            } catch (OrmException $error) {
                self::assertContains($error->code_, [Code::CONFIG, Code::INTERNAL]);
            }
        }
    }

    public function testGroupValueRejectsInvalidStoredBoolean(): void
    {
        $this->assertGroupValueOwnership();
        $db = (new \ReflectionClass(Db::class))->newInstanceWithoutConstructor();
        $groupValue = new \ReflectionMethod(Model::class, 'groupValue');
        // A driver that returns a native boolean (PostgreSQL) gives false and true, which are valid stored values.
        foreach ([false, true] as $native) {
            self::assertSame($native, $groupValue->invoke(
                new GroupRowsModelFixture(),
                $db,
                ['name' => 'active', 'column' => '', 'type' => 'bool'],
                $native,
            ));
        }
        try {
            $groupValue->invoke(
                new GroupRowsModelFixture(),
                $db,
                ['name' => 'active', 'column' => '', 'type' => 'bool'],
                'invalid',
            );
            self::fail('invalid boolean group value was accepted');
        } catch (OrmException $error) {
            self::assertSame(Code::CODEC_DECODE, $error->code_);
            self::assertSame('CODEC_DECODE: group column active is not boolean', $error->getMessage());
        }
    }

    public function testGroupResultPreservesExactI64Value(): void
    {
        $this->assertGroupValueOwnership();
        $db = (new \ReflectionClass(Db::class))->newInstanceWithoutConstructor();
        $groupValue = new \ReflectionMethod(Model::class, 'groupValue');
        $want = 9007199254740991;
        $value = $groupValue->invoke(
            new GroupRowsModelFixture(),
            $db,
            ['name' => 'exact_value', 'column' => '', 'type' => 'i64'],
            $want,
        );
        self::assertSame($want, $value);
        $row = new GroupRow([['exact_value', $value], ['row_count', 1]]);
        self::assertSame($want, $row->value('exact_value'));
        self::assertSame(['exact_value' => $want, 'row_count' => 1], $row->toArray());
    }

    public function testGroupRowCountEnforcesExactness(): void
    {
        $this->assertGroupRowOwnership();
        foreach ([true, -1, '-1', '00', 1.5, 9007199254740992, 9007199254740992.0, '9007199254740992'] as $invalid) {
            try {
                new GroupRow([['row_count', $invalid]]);
                self::fail('an invalid row_count was accepted');
            } catch (OrmException $error) {
                self::assertSame(Code::CODEC_DECODE, $error->code_);
                $this->assertGroupRowCountError($error);
            }
        }
        try {
            new GroupRow([['selected', 'x']]);
            self::fail('a missing row_count was accepted');
        } catch (OrmException $error) {
            self::assertSame(Code::INTERNAL, $error->code_);
        }
        foreach ([0, '0', 9007199254740991, '9007199254740991'] as $input) {
            $row = new GroupRow([['row_count', $input]]);
            $expected = (int) $input;
            self::assertSame($expected, $row->count());
            self::assertSame($expected, $row->toArray()['row_count']);
        }
    }
}
