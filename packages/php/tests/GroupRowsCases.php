<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Code;
use Polyspec\Orm\GroupRow;
use Polyspec\Orm\OrmException;

/** Shared group-result behavior checks for the PHP library and extension. */
trait GroupRowsCases
{
    protected function assertGroupRowOwnership(): void
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

    // The forms of a count that only a driver cell holds: a text and a float. The answer of a listener holds neither,
    // since its count is a JSON number (PRT-69), so the collection recipe cannot write them (FCV-2).
    // Requirements: INT-68, INT-90.
    public function testGroupRowDriverCellForms(): void
    {
        $this->assertGroupRowOwnership();
        foreach (['three', '-1', '00', '+1', '', '9007199254740992', 1.5, -1.0, 9007199254740992.0] as $invalid) {
            try {
                new GroupRow([['row_count', $invalid]]);
                self::fail('an invalid row_count was accepted');
            } catch (OrmException $error) {
                self::assertSame(Code::CODEC_DECODE, $error->code_);
                $this->assertGroupRowCountError($error);
            }
        }
        $forms = [
            ['0', 0],
            ['9007199254740991', 9007199254740991],
            [3.0, 3],
            [9007199254740991.0, 9007199254740991],
        ];
        foreach ($forms as [$input, $expected]) {
            $row = new GroupRow([['row_count', $input]]);
            self::assertSame($expected, $row->count());
            self::assertSame($expected, $row->toArray()['row_count']);
        }
        try {
            new GroupRow([['row_count', 1], ['row_count', 2]]);
            self::fail('a repeated row_count was accepted');
        } catch (OrmException $error) {
            self::assertSame(Code::CONFIG, $error->code_);
        }
    }
}
