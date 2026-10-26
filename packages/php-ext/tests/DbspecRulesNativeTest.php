<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\Dbspec;
use InvalidArgumentException;

final class DbspecRulesNativeTest extends TestCase
{
    // Requirements: DBS-174.
    public function testNativeRenderRejectsUnknownDialect(): void
    {
        $parsed = Dbspec::parse("dbspec 1 dialect\n\ntable item {\n  id i64\n  primary key (id)\n}\n", []);
        self::assertNotNull($parsed->document, json_encode($parsed->diagnostics, JSON_THROW_ON_ERROR));
        $this->expectException(InvalidArgumentException::class);
        $this->expectExceptionMessage('oracle');
        Dbspec::render([$parsed->document], 'oracle');
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
}
