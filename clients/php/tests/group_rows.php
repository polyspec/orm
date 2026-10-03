<?php
declare(strict_types=1);

require __DIR__ . '/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';

use Orm\Code;
use Orm\GroupRow;
use Orm\GroupRows;
use Orm\OrmException;

testcase_begin('group_rows/owner', TESTCASE_COMPUTE);
$row = new GroupRow([['is_close', false], ['row_count', 3]]);
if ($row->count() !== 3 || $row->value('is_close') !== false || $row->toArray() !== ['is_close' => false, 'row_count' => 3]) {
    throw new RuntimeException('group result lost a selected value or count');
}
try {
    $row->value('name');
    throw new RuntimeException('unselected group value was accepted');
} catch (OrmException $error) {
    if ($error->code_ !== Code::COLUMN_UNSELECTED) throw $error;
}
$rows = new GroupRows([$row]);
if (count($rows) !== 1 || $rows->toArray() !== [['is_close' => false, 'row_count' => 3]]) {
    throw new RuntimeException('group result collection changed the row');
}
foreach ([
    [['is_close', false]],
    [['row_count', true]],
    [['row_count', -1]],
    [['row_count', 1.5]],
    [['row_count', '900719925474099300000']],
    [['row_count', 1], ['row_count', 2]],
    [['row_count', 1, 'extra']],
] as $invalid) {
    try {
        new GroupRow($invalid);
        throw new RuntimeException('invalid group count was accepted');
    } catch (OrmException $error) {
        if (!in_array($error->code_, [Code::CODEC_DECODE, Code::INTERNAL, Code::CONFIG], true)) throw $error;
    }
}
testcase_end();
