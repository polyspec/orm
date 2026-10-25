<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\Dbspec;

require_once dirname(__DIR__, 2) . '/php/tests/dbspec_limit_cases.php';

final class DbspecRulesNativeTest extends TestCase
{
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
