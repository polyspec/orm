<?php
declare(strict_types=1);

// The extension's Polyspec\Orm\Dbspec\Native\Names against the PHP client's Names (docs/dbspec.md "Names"): render,
// ofTable and column give the same results, and the same exception classes, for the same inputs.
//
// Usage: php -d extension=<orm_dbspec library> packages/orm-php-extension/tests/dbspec_names_test.php

use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Names;
use Polyspec\Orm\Dbspec\Native\Dbspec as NativeDbspec;
use Polyspec\Orm\Dbspec\Native\Names as NativeNames;

$root = dirname(__DIR__, 3);
require "$root/packages/orm-php/tests/autoload.php";

if (!extension_loaded('orm_dbspec')) {
    fwrite(STDERR, "the extension orm_dbspec is not loaded; run make dbspec-php-extension-check, which builds and loads it\n");
    exit(1);
}

function same(string $what, mixed $want, mixed $got): void
{
    if ($want !== $got) {
        throw new RuntimeException("$what: the extension differs from the PHP client\nwant " . json_encode($want) . "\ngot  " . json_encode($got));
    }
}

/** The outcome of a call: its result, or the class of the exception it throws. */
function outcome(callable $call): array
{
    try {
        return ['value' => $call()];
    } catch (Throwable $e) {
        return ['exception' => $e::class];
    }
}

// render: the plain form at most 63 bytes, otherwise the first 54 bytes, a $ and 8 hex digits of the SHA-256.
$pairs = [
    ['t', 'c'],
    ['orders', 'immutable_update'],
    [str_repeat('a', 61), 'c'],          // exactly 63 bytes: plain
    [str_repeat('a', 62), 'c'],          // 64 bytes: hashed
    [str_repeat('a', 62), 'abc'],
    ["caf\u{e9}_" . str_repeat('x', 56), 'name'], // multi-byte: the cut is by bytes
    ['x', ''],
];
foreach ($pairs as [$table, $suffix]) {
    same("render($table, $suffix)", Names::render($table, $suffix), NativeNames::render($table, $suffix));
}

// column: the first element whose renderer name is the name; null when none does.
$table = 'orders';
$target = Names::render($table, 'c_' . str_repeat('y', 60));
$columns = ['id', 'c_' . str_repeat('y', 60), 'other', 'c_' . str_repeat('y', 60)];
same('column array hit', Names::column($table, $target, $columns), NativeNames::column($table, $target, $columns));
same('column array miss', Names::column($table, 'nothing$00000000', $columns), NativeNames::column($table, 'nothing$00000000', $columns));
same('column empty array', Names::column($table, $target, []), NativeNames::column($table, $target, []));

// column with a Traversable: the first match ends the iteration, so a later element is never read.
$generator = static function () use ($target): Generator {
    yield 'id';
    yield 'c_' . str_repeat('y', 60);
    throw new RuntimeException('read past the first match');
};
same('column generator stops at the match', Names::column($table, $target, $generator()), NativeNames::column($table, $target, $generator()));
$iterator = new ArrayIterator(['id', 'c_' . str_repeat('y', 60)]);
same('column ArrayIterator', Names::column($table, $target, $iterator), NativeNames::column($table, $target, new ArrayIterator(['id', 'c_' . str_repeat('y', 60)])));

// A column element that is not a string is a TypeError in both.
same(
    'column non-string element',
    outcome(static fn() => Names::column($table, $target, ['id', 5])),
    outcome(static fn() => NativeNames::column($table, $target, ['id', 5])),
);

// ofTable: the same renderer names for the same parsed table, in the same order.
$long = str_repeat('a', 62);
$text = "dbspec 1 d\n"
    . "table orders {\n"
    . "  id i64 identity\n"
    . "  note text\n"
    . "  code varchar(40) null\n"
    . "  amount decimal(10,2)\n"
    . "  primary key (id)\n"
    . "  settings {\n"
    . "    immutable\n"
    . "  }\n"
    . "}\n"
    . "table $long {\n"
    . "  id i64 identity\n"
    . "  c_long_column_name_that_is_hashed i64\n"
    . "  primary key (id)\n"
    . "}\n";
$php = Dbspec::parse($text, ['d' => $text]);
$native = NativeDbspec::parse($text, ['d' => $text]);
same('parse ok', [null, null], [$php->diagnostics ?: null, $native->diagnostics ?: null]);
foreach ($php->document->tables as $i => $phpTable) {
    same("ofTable {$phpTable->name}", Names::ofTable($phpTable), NativeNames::ofTable($native->document->tables[$i]));
}

echo "names: render, column and ofTable equal the PHP client\n";
