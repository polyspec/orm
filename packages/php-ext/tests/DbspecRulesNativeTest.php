<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\Dbspec;

final class DbspecRulesNativeTest extends TestCase
{
    // Requirements: DBS-32, DBS-36, DBS-38, DBS-39, DBS-42, DBS-43, DBS-46, DBS-48, DBS-50, DBS-58.
    // Requirements: DBS-144.
    public function testNativeRuleDiagnosticsMatchGoCoordinatesAndOrdering(): void
    {
        self::assertTrue((new \ReflectionMethod(Dbspec::class, 'parse'))->isInternal());
        $cases = [
            'empty-key-list' => [
                ['dbspec 1 shop', '', 'table users {', '  id i64 identity', '  primary key ()', '}'],
                [[5, 16, 'syntax']],
            ],
            'check-outside-neutral-set' => [
                [
                    'dbspec 1 shop', '', 'table users {', '  id i64 identity', '  primary key (id)',
                    '  check ck_a (id like 1)', '  check ck_b (id > -id)', '  check ck_c (id AND 1)',
                    '  check ck_d (id in (id))', '  check ck_e ((id > 0)', '}',
                ],
                [[6, 18, 'check'], [7, 20, 'check'], [8, 18, 'check'], [9, 22, 'check'], [10, 22, 'check']],
            ],
            'reserved-word-and-tie-order' => [
                [
                    'dbspec 1 shop', '', 'table users {', '  id i64 identity',
                    '  Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa i32',
                    '  primary key (id)', '  index identity (id)', '}',
                ],
                [[5, 3, 'name.format'], [5, 3, 'name.length'], [7, 9, 'name.format']],
            ],
            'diagram-repeat-and-coordinates' => [
                [
                    'dbspec 1 shop', '', 'table users {', '  id i64 identity', '  primary key (id)', '}', '',
                    'diagram main {', '  users at 1.5 x', '  users at 0 0', '}',
                ],
                [[9, 12, 'diagram'], [9, 16, 'diagram'], [10, 3, 'diagram']],
            ],
        ];

        foreach ($cases as $id => [$lines, $expected]) {
            $result = Dbspec::parse(implode("\n", $lines) . "\n", []);
            self::assertNull($result->document, $id);
            $actual = array_map(
                static fn($diagnostic): array => [$diagnostic->line, $diagnostic->column, $diagnostic->rule],
                $result->diagnostics
            );
            self::assertSame($expected, $actual, $id);
        }
    }
}
