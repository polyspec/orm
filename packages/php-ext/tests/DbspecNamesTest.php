<?php
declare(strict_types=1);

// The extension's Polyspec\Orm\Dbspec\Native\Names against the PHP client's Names (docs/dbspec.md "Names"): render,
// ofTable and column give the same results, and the same exception classes, for the same inputs.

use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Names;
use Polyspec\Orm\Dbspec\Native\Dbspec as NativeDbspec;
use Polyspec\Orm\Dbspec\Native\Names as NativeNames;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

/** The outcome of a call: its result, or the class of the exception it throws. */
function names_outcome(callable $call): array
{
    try {
        return ['value' => $call()];
    } catch (Throwable $e) {
        return ['exception' => $e::class];
    }
}

#[Small]
final class DbspecNamesTest extends TestCase
{
    // render: the plain form at most 63 bytes, otherwise the first 54 bytes, a $ and 8 hex digits of the SHA-256.
    public static function renderPairs(): iterable
    {
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
            yield "render($table, $suffix)" => [$table, $suffix];
        }
    }

    #[DataProvider('renderPairs')]
    public function test_render(string $table, string $suffix): void
    {
        $this->assertSame(Names::render($table, $suffix), NativeNames::render($table, $suffix), "render($table, $suffix): the extension differs from the PHP client");
    }

    public function test_column(): void
    {
        // column: the first element whose renderer name is the name; null when none does.
        $table = 'orders';
        $target = Names::render($table, 'c_' . str_repeat('y', 60));
        $columns = ['id', 'c_' . str_repeat('y', 60), 'other', 'c_' . str_repeat('y', 60)];
        $this->assertSame(Names::column($table, $target, $columns), NativeNames::column($table, $target, $columns), 'column array hit');
        $this->assertSame(Names::column($table, 'nothing$00000000', $columns), NativeNames::column($table, 'nothing$00000000', $columns), 'column array miss');
        $this->assertSame(Names::column($table, $target, []), NativeNames::column($table, $target, []), 'column empty array');

        // column with a Traversable: the first match ends the iteration, so a later element is never read.
        $generator = static function () use ($target): Generator {
            yield 'id';
            yield 'c_' . str_repeat('y', 60);
            throw new RuntimeException('read past the first match');
        };
        $this->assertSame(Names::column($table, $target, $generator()), NativeNames::column($table, $target, $generator()), 'column generator stops at the match');
        $iterator = new ArrayIterator(['id', 'c_' . str_repeat('y', 60)]);
        $this->assertSame(Names::column($table, $target, $iterator), NativeNames::column($table, $target, new ArrayIterator(['id', 'c_' . str_repeat('y', 60)])), 'column ArrayIterator');

        // A column element that is not a string is a TypeError in both.
        $this->assertSame(
            names_outcome(static fn() => Names::column($table, $target, ['id', 5])),
            names_outcome(static fn() => NativeNames::column($table, $target, ['id', 5])),
            'column non-string element',
        );
    }

    public function test_of_table(): void
    {
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
        $this->assertSame([null, null], [$php->diagnostics ?: null, $native->diagnostics ?: null], 'parse ok');
        foreach ($php->document->tables as $i => $phpTable) {
            $this->assertSame(Names::ofTable($phpTable), NativeNames::ofTable($native->document->tables[$i]), "ofTable {$phpTable->name}");
        }
    }
}
