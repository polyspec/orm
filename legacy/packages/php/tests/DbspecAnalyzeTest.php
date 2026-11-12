<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// Syntax analysis (docs/spec/dbspec.md "Syntax analysis") through the PHP client: the focused case whose text holds an
// invalid UTF-8 byte, which no recipe text can hold. The limit stop and the other focused cases are recipe cases
// (analyze-limit-no-tokens and the analyze cases of tests/dbspec/canonical.json and tests/dbspec/invalid.json).
// Requirements: DBS-134, DBS-135, DBS-138, DBS-144.

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
}
