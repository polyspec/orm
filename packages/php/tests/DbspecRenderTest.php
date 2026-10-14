<?php
declare(strict_types=1);
// The statement vectors of tests/dbspec/ddl.json through
// Polyspec\Orm\Dbspec\Dbspec::render, and the unknown dialect rule.
require_once __DIR__ . '/case_clock.php';

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

    // 모든 vector를 합친 CPU 시간이 10 s 기준값을 넘으면 경고한다.
    public static function tearDownAfterClass(): void
    {
        [$cpuMs, $wallMs] = caseClockElapsed(self::$started);
        if ($cpuMs > 10000) {
            caseClockWarning(sprintf('dbspec_render used %.3f ms of CPU (%.3f ms wall), above its reference of 10 s', $cpuMs, $wallMs));
        }
    }

    /** @param list<string> $lines */
    private static function text(array $lines): string
    {
        return implode("\n", $lines) . "\n";
    }

    public static function ddlCases(): iterable
    {
        $vectors = json_decode(file_get_contents(dirname(__DIR__, 3) . '/tests/dbspec/ddl.json'), true, 512, JSON_THROW_ON_ERROR);
        if (($vectors['cases'] ?? []) === []) {
            throw new RuntimeException('Missing ddl vectors');
        }
        foreach ($vectors['cases'] as $case) {
            yield 'ddl/' . $case['id'] => [$case];
        }
    }

    // 각 vector는 memory 안에서 문서 하나를 세 dialect로 렌더링한다.
    #[DataProvider('ddlCases')]
    public function test_ddl(array $case): void
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
            $this->assertNotNull($result->document, "{$case['id']}/$name: diagnostics " . json_encode(array_map(fn($d) => [$d->rule, $d->line, $d->column, $d->message], $result->diagnostics)));
            $documents[] = $result->document;
        }
        foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
            $this->assertArrayHasKey($dialect, $case['statements'], "{$case['id']}: no $dialect statements");
            $want = $case['statements'][$dialect];
            // 문서 집합의 순서는 결과를 바꾸지 않는다.
            foreach ([$documents, array_reverse($documents)] as $set) {
                $rendered = Dbspec::render($set, $dialect);
                $this->assertNotNull($rendered->statements, "{$case['id']}/$dialect: diagnostics " . json_encode(array_map(fn($d) => [$d->rule, $d->line, $d->column, $d->message], $rendered->diagnostics)));
                $this->assertSame($want, $rendered->statements, "{$case['id']}/$dialect: statements differ");
            }
        }
    }

    public function test_unknown_dialect(): void
    {
        $this->expectException(InvalidArgumentException::class);
        $this->expectExceptionMessage('oracle');
        Dbspec::render([], 'oracle');
    }
}
