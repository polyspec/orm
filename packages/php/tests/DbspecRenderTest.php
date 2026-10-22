<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// The statement vectors of tests/dbspec/ddl.json through
// Polyspec\Orm\Dbspec\Dbspec::render, and the unknown dialect rule.

use InvalidArgumentException;
use RuntimeException;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\Dbspec;

#[Small]
final class DbspecRenderTest extends TestCase
{
    private static array $started;

    public static function setUpBeforeClass(): void
    {
        self::$started = caseClockStart();
    }

    // Warns if the CPU time of all vectors together exceeds the 10 s baseline.
    public static function tearDownAfterClass(): void
    {
        [$cpuMs, $wallMs] = caseClockElapsed(self::$started);
        if ($cpuMs > 10000) {
            caseClockWarning(
                sprintf(
                    'dbspec_render used %.3f ms of CPU (%.3f ms wall), above its reference of 10 s',
                    $cpuMs,
                    $wallMs
                )
            );
        }
    }

    /** @param list<string> $lines */
    private static function text(array $lines): string
    {
        return implode("\n", $lines) . "\n";
    }

    public static function ddlCases(): iterable
    {
        $vectors = json_decode(
            file_get_contents(dirname(__DIR__, 3) . '/tests/dbspec/ddl.json'),
            true,
            512,
            JSON_THROW_ON_ERROR
        );
        if (($vectors['cases'] ?? []) === []) {
            throw new RuntimeException('Missing ddl vectors');
        }
        foreach ($vectors['cases'] as $case) {
            yield $case['id'] => [$case];
        }
    }

    // Each vector renders one document in memory in three dialects.
    #[DataProvider('ddlCases')]
    public function testDdl(array $case): void
    {
        $documents = [];
        foreach ($case['documents'] as $name => $lines) {
            $set = [];
            foreach ($case['documents'] as $other => $otherLines) {
                if ($other !== $name) {
                    $set[$other] = self::text($otherLines);
                }
            }
            $result = Dbspec::parse(self::text($lines), $set);
            $this->assertNotNull(
                $result->document,
                "{$case['id']}/$name: diagnostics " . json_encode(
                    array_map(fn($d) => [$d->rule, $d->line, $d->column, $d->message], $result->diagnostics)
                )
            );
            $documents[] = $result->document;
        }
        foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
            $this->assertArrayHasKey($dialect, $case['statements'], "{$case['id']}: no $dialect statements");
            $want = $case['statements'][$dialect];
            // The order of the document set does not change the result.
            foreach ([$documents, array_reverse($documents)] as $set) {
                $rendered = Dbspec::render($set, $dialect);
                $this->assertNotNull(
                    $rendered->statements,
                    "{$case['id']}/$dialect: diagnostics " . json_encode(
                        array_map(fn($d) => [$d->rule, $d->line, $d->column, $d->message], $rendered->diagnostics)
                    )
                );
                $this->assertSame($want, $rendered->statements, "{$case['id']}/$dialect: statements differ");
            }
        }
    }

    public function testUnknownDialect(): void
    {
        $this->expectException(InvalidArgumentException::class);
        $this->expectExceptionMessage('oracle');
        Dbspec::render([], 'oracle');
    }
}
