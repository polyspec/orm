<?php

declare(strict_types=1);

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\GroupRow;
use Polyspec\Orm\GroupRows;
use Polyspec\Orm\OrmException;

#[Small]
final class GroupRowsTest extends TestCase
{
    public function test_owner(): void
    {
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

    // Requirements: INT-90.
    public function test_negative_count_is_codec_decode(): void
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
}
