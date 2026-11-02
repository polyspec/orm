<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// Syntax analysis and formatting (docs/spec/dbspec.md "Syntax analysis", "Formatting") through the PHP client:
// focused token cases and the limit stop.

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Token;

#[Small]
class DbspecAnalyzeTest extends TestCase
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
    public function testFocused(string $text, array $want): void
    {
        $id = (string) $this->dataName();
        $clock = cpuCaseBegin(2.0);
        $this->assertSame($want, self::tokens($text, [$id => $text]), "$id: tokens differ");
        cpuCaseEnd($id, $clock);
    }

    // R22: a limit stop gives no tokens, whatever was marked before it.
    public function testLimitNoTokens(): void
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
        $this->assertNotSame(
            [],
            $analysis->diagnostics,
            'analyze/limit-no-tokens: a limit stop must give the limit diagnostic'
        );
        $this->assertSame(
            'limit',
            $analysis->diagnostics[array_key_last($analysis->diagnostics)]->rule,
            'analyze/limit-no-tokens: the last diagnostic must be the limit'
        );
        cpuCaseEnd('analyze/limit-no-tokens', $clock);
    }
}
