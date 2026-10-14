<?php
declare(strict_types=1);
// Syntax analysis and formatting (docs/dbspec.md "Syntax analysis", "Formatting") through the PHP client:
// focused token cases, the shared cases of tests/dbspec/cases.json, the shared syntax vectors of
// tests/dbspec/syntax.json, and the limit stop.
require_once __DIR__ . '/case_clock.php';
require_once __DIR__ . '/dbspec_cases.php';
require_once __DIR__ . '/dbspec_analysis_cases.php';
require_once __DIR__ . '/dbspec_syntax_vectors.php';

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Token;

#[Small]
final class DbspecAnalyzeTest extends TestCase
{
    /** @return list<array{0:int,1:int,2:int,3:string}> */
    private static function tokens(string $text, array $documents): array
    {
        $analysis = Dbspec::analyze($text, $documents);
        return array_map(static fn(Token $t): array => [$t->line, $t->start, $t->end, $t->class], $analysis->tokens);
    }

    public static function focusedCases(): iterable
    {
        foreach (dbspec_analysis_focused_cases() as $id => [$text, $want]) {
            yield "analyze/$id" => [$text, $want];
        }
    }

    #[DataProvider('focusedCases')]
    public function test_focused(string $text, array $want): void
    {
        $id = (string) $this->dataName();
        $clock = cpuCaseBegin(2.0);
        $this->assertSame($want, self::tokens($text, [$id => $text]), "$id: tokens differ");
        cpuCaseEnd($id, $clock);
    }

    // R22: a limit stop gives no tokens, whatever was marked before it.
    public function test_limit_no_tokens(): void
    {
        $clock = cpuCaseBegin(2.0);
        $lines = [];
        for ($i = 1; $i <= 4097; $i++) {
            $lines[] = "table t$i {";
            $lines[] = '}';
        }
        $limitText = "dbspec 1 d\n" . implode("\n", $lines) . "\n";
        $analysis = Dbspec::analyze($limitText, ['d' => $limitText]);
        $this->assertSame([], $analysis->tokens, 'analyze/limit-no-tokens: a limit stop must give no tokens');
        $this->assertNull($analysis->document, 'analyze/limit-no-tokens: a limit stop must give no document');
        $this->assertNotSame([], $analysis->diagnostics, 'analyze/limit-no-tokens: a limit stop must give the limit diagnostic');
        $this->assertSame('limit', $analysis->diagnostics[array_key_last($analysis->diagnostics)]->rule, 'analyze/limit-no-tokens: the last diagnostic must be the limit');
        cpuCaseEnd('analyze/limit-no-tokens', $clock);
    }

    public static function sharedCases(): iterable
    {
        $cases = dbspec_read_cases();
        foreach (['canonical', 'normalize', 'invalid'] as $kind) {
            yield from dbspec_case_sets($kind, $cases[$kind]);
        }
    }

    // The shared cases: analyze returns the parse result unchanged, and format of each canonical or normalize case
    // gives its canonical text; an invalid case is refused with its diagnostics (docs/dbspec.md "Formatting").
    #[DataProvider('sharedCases')]
    public function test_shared(string $kind, array $case): void
    {
        $id = "$kind/" . $case['id'];
        $clock = cpuCaseBegin(2.0);
        $texts = dbspec_documents($case['documents'], $case['crlf'] ?? false, $case['mixed'] ?? false);
        $text = $texts[$case['main']];
        $parsed = Dbspec::parse($text, $texts);
        $analysis = Dbspec::analyze($text, $texts);
        $this->assertEquals($parsed->diagnostics, $analysis->diagnostics, "analyze/$id: the parse result is not returned unchanged");
        $this->assertEquals($parsed->positions, $analysis->positions, "analyze/$id: the parse result is not returned unchanged");
        $this->assertSame($parsed->document === null, $analysis->document === null, "analyze/$id: the parse result is not returned unchanged");
        if ($parsed->document !== null) {
            $this->assertSame(Dbspec::emit($parsed->document), Dbspec::emit($analysis->document), "analyze/$id: the document differs from parse");
        }
        $format = Dbspec::format($text, $texts);
        if ($kind === 'invalid') {
            $this->assertNull($format->text, "format/$id: an invalid document was formatted");
            $got = array_map(static fn($d): array => ['line' => $d->line, 'column' => $d->column, 'rule' => $d->rule], $format->diagnostics);
            $want = array_map(static fn(array $e): array => ['line' => $e['line'], 'column' => $e['column'], 'rule' => $e['rule']], $case['errors']);
            $this->assertSame($want, $got, "format/$id: diagnostics differ");
        } else {
            $want = $kind === 'canonical' ? implode("\n", $case['documents'][$case['main']]) . "\n" : implode("\n", $case['canonical']) . "\n";
            $this->assertSame([], $format->diagnostics, "format/$id: diagnostics");
            $this->assertSame($want, $format->text, "format/$id: text differs from the canonical text");
            $formatted = $texts;
            $formatted[$case['main']] = $format->text;
            $again = Dbspec::format($format->text, $formatted);
            $this->assertSame($format->text, $again->text, "format/$id: format is not idempotent");
        }
        cpuCaseEnd("analyze/$id", $clock);
    }

    public static function syntaxCases(): iterable
    {
        return dbspec_syntax_sets(dirname(__DIR__, 3), dbspec_read_cases());
    }

    // The shared syntax vectors: the tokens of every case of tests/dbspec/syntax.json, exactly.
    #[DataProvider('syntaxCases')]
    public function test_syntax(?array $want, string $text, array $documents): void
    {
        $this->assertNotNull($want, $this->dataName() . ': syntax.json has no tokens for this case');
        $this->assertSame($want, self::tokens($text, $documents), $this->dataName() . ': tokens differ');
    }

    public function test_syntax_cases_are_produced(): void
    {
        $this->assertSame([], dbspec_syntax_unproduced(dirname(__DIR__, 3), dbspec_read_cases()), 'syntax.json has cases that the inputs do not produce');
    }
}
