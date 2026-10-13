<?php
declare(strict_types=1);
// Syntax analysis and formatting (docs/dbspec.md "Syntax analysis", "Formatting") through the PHP client:
// focused token cases, the shared cases of tests/dbspec/cases.json, and the limit stop.
require __DIR__ . '/autoload.php';
require_once __DIR__ . '/case_clock.php';
require __DIR__ . '/dbspec_cases.php';
require __DIR__ . '/dbspec_analysis_cases.php';
require __DIR__ . '/dbspec_syntax_vectors.php';

use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Token;

$root = dirname(__DIR__, 3);
$cases = dbspec_read_cases();

/** @return list<array{0:int,1:int,2:int,3:string}> */
function analysis_tokens(string $text, array $documents): array
{
    $analysis = Dbspec::analyze($text, $documents);
    return array_map(static fn(Token $t): array => [$t->line, $t->start, $t->end, $t->class], $analysis->tokens);
}

/** @param list<array{0:int,1:int,2:int,3:string}> $want */
function expect_tokens(string $id, string $text, array $want): void
{
    $got = analysis_tokens($text, [$id => $text]);
    if ($got !== $want) {
        throw new RuntimeException("$id: tokens differ\nwant " . json_encode($want) . "\ngot  " . json_encode($got));
    }
}

$focused = dbspec_analysis_focused_cases();
$counts = ['focused' => 0];
foreach ($focused as $id => [$text, $want]) {
    $clock = cpuCaseBegin("analyze/$id", 2.0);
    expect_tokens("analyze/$id", $text, $want);
    cpuCaseEnd("analyze/$id", $clock);
    $counts['focused']++;
}

// R22: a limit stop gives no tokens, whatever was marked before it.
$clock = cpuCaseBegin('analyze/limit-no-tokens', 2.0);
$lines = [];
for ($i = 1; $i <= 4097; $i++) {
    $lines[] = "table t$i {";
    $lines[] = '}';
}
$limitText = "dbspec 1 d\n" . implode("\n", $lines) . "\n";
$analysis = Dbspec::analyze($limitText, ['d' => $limitText]);
if ($analysis->tokens !== [] || $analysis->document !== null || $analysis->diagnostics === [] || $analysis->diagnostics[array_key_last($analysis->diagnostics)]->rule !== 'limit') {
    throw new RuntimeException('analyze/limit-no-tokens: a limit stop must give no tokens and the limit diagnostic');
}
cpuCaseEnd('analyze/limit-no-tokens', $clock);
$counts['limit'] = 1;

// The shared cases: analyze returns the parse result unchanged, and format of each canonical or normalize case
// gives its canonical text; an invalid case is refused with its diagnostics (docs/dbspec.md "Formatting").
foreach (['canonical', 'normalize', 'invalid'] as $kind) {
    foreach ($cases[$kind] as $case) {
        $id = "$kind/" . $case['id'];
        $clock = cpuCaseBegin("analyze/$id", 2.0);
        $texts = dbspec_documents($case['documents'], $case['crlf'] ?? false, $case['mixed'] ?? false);
        $text = $texts[$case['main']];
        $parsed = Dbspec::parse($text, $texts);
        $analysis = Dbspec::analyze($text, $texts);
        if ($analysis->diagnostics != $parsed->diagnostics || $analysis->positions != $parsed->positions
            || ($analysis->document === null) !== ($parsed->document === null)) {
            throw new RuntimeException("analyze/$id: the parse result is not returned unchanged");
        }
        if ($parsed->document !== null && Dbspec::emit($analysis->document) !== Dbspec::emit($parsed->document)) {
            throw new RuntimeException("analyze/$id: the document differs from parse");
        }
        $format = Dbspec::format($text, $texts);
        if ($kind === 'invalid') {
            if ($format->text !== null) {
                throw new RuntimeException("format/$id: an invalid document was formatted");
            }
            $got = array_map(static fn($d): array => ['line' => $d->line, 'column' => $d->column, 'rule' => $d->rule], $format->diagnostics);
            $want = array_map(static fn(array $e): array => ['line' => $e['line'], 'column' => $e['column'], 'rule' => $e['rule']], $case['errors']);
            if ($got !== $want) {
                throw new RuntimeException("format/$id: diagnostics differ\nwant " . json_encode($want) . "\ngot  " . json_encode($got));
            }
        } else {
            $want = $kind === 'canonical' ? implode("\n", $case['documents'][$case['main']]) . "\n" : implode("\n", $case['canonical']) . "\n";
            if ($format->diagnostics !== [] || $format->text !== $want) {
                throw new RuntimeException("format/$id: text differs from the canonical text\n--- want\n$want--- got\n" . (string) $format->text);
            }
            $formatted = $texts;
            $formatted[$case['main']] = $format->text;
            $again = Dbspec::format($format->text, $formatted);
            if ($again->text !== $format->text) {
                throw new RuntimeException("format/$id: format is not idempotent");
            }
        }
        cpuCaseEnd("analyze/$id", $clock);
        $counts[$kind] = ($counts[$kind] ?? 0) + 1;
    }
}

// The shared syntax vectors: the tokens of every case of tests/dbspec/syntax.json, exactly.
$syntaxCount = dbspec_syntax_check(
    dbspec_syntax_load($root),
    dbspec_syntax_inputs($cases),
    static fn(string $text, array $documents): array => array_map(static fn(Token $t): array => [$t->line, $t->start, $t->end, $t->class], Dbspec::analyze($text, $documents)->tokens),
);
echo "syntax.json: $syntaxCount cases match\n";
