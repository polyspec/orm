<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use InvalidArgumentException;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\Dbspec;

final class DbspecRulesNativeTest extends TestCase
{
    // Requirements: DBS-174.
    public function testNativeRenderRejectsUnknownDialect(): void
    {
        DbspecDialectRejectionCases::assertRenderRejectsUnknownDialect($this);
    }

    // Requirements: DBS-174.
    public function testNativePlanStepsRejectUnknownDialect(): void
    {
        $path = dirname(__DIR__, 3) . '/tests/dbspec/plans.json';
        $vectors = json_decode(file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
        $text = implode("\n", $vectors['cases'][0]['plan']) . "\n";
        $plan = Dbspec::parsePlan($text);
        self::assertNotNull($plan->plan, json_encode($plan->diagnostics, JSON_THROW_ON_ERROR));
        $this->expectException(InvalidArgumentException::class);
        $this->expectExceptionMessage('oracle');
        Dbspec::planSteps(null, $plan->plan, 'oracle');
    }

    // Requirements: DBS-144, DBS-170.
    public function testNativeGlobalColumnLimit(): void
    {
        [$text, $want] = rules_limit('columns');
        $this->assertNativeLimit($text, $want);
    }

    // Requirements: DBS-144, DBS-170.
    public function testNativeForeignKeyCountLimit(): void
    {
        [$text, $want] = rules_limit('foreign-keys');
        $this->assertNativeLimit($text, $want);
    }

    // Requirements: DBS-144, DBS-151, DBS-170.
    public function testNativeDocumentAndTableLimits(): void
    {
        foreach (['size', 'tables', 'table-columns'] as $id) {
            $clock = cpuCaseBegin(20.0);
            [$text, $want] = rules_limit($id);
            $this->assertNativeLimit($text, $want);
            cpuCaseEnd("limit/$id", $clock);
        }
    }

    /** @param array{string, int, int} $want */
    private function assertNativeLimit(string $text, array $want): void
    {
        self::assertTrue((new \ReflectionMethod(Dbspec::class, 'parse'))->isInternal());
        $previousMemoryLimit = ini_get('memory_limit');
        self::assertIsString($previousMemoryLimit);
        self::assertNotFalse(ini_set('memory_limit', '512M'));
        try {
            $result = Dbspec::parse($text, []);
        } finally {
            self::assertNotFalse(ini_set('memory_limit', $previousMemoryLimit));
        }
        self::assertNull($result->document);
        self::assertSame(
            [$want],
            array_map(
                static fn($diagnostic): array => [$diagnostic->rule, $diagnostic->line, $diagnostic->column],
                $result->diagnostics
            )
        );
    }

    // Requirements: DBS-32, DBS-36, DBS-38, DBS-39, DBS-42, DBS-43, DBS-46, DBS-48, DBS-50, DBS-58.
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
