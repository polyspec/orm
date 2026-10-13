<?php
declare(strict_types=1);
// Syntax analysis and formatting (docs/dbspec.md "Syntax analysis", "Formatting") through the PHP client:
// focused token cases, the shared cases of tests/dbspec/cases.json, and the limit stop.
require __DIR__ . '/autoload.php';
require_once __DIR__ . '/case_clock.php';
require __DIR__ . '/dbspec_cases.php';

use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Token;

$root = dirname(__DIR__, 3);
$cases = json_decode(file_get_contents("$root/tests/dbspec/cases.json"), true, 512, JSON_THROW_ON_ERROR);

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

// Focused cases: each class follows its rule of docs/dbspec.md "Syntax analysis" and the brief's R1-R22.
$focused = [
    'header-and-table' => [
        "dbspec 1 d\ntable t {\n  id i64\n}\n",
        [[1, 0, 6, 'keyword'], [1, 7, 8, 'number'], [1, 9, 10, 'name'],
            [2, 0, 5, 'keyword'], [2, 6, 7, 'name'], [2, 8, 9, 'punctuation'],
            [3, 2, 4, 'name'], [3, 5, 8, 'type'],
            [4, 0, 1, 'punctuation']],
    ],
    // R1: a line with a syntax diagnostic has only word tokens; its punctuation and operators keep their class.
    'abandoned-column-line' => [
        "dbspec 1 d\ntable t {\n  id i64 bogus\n}\n",
        [[1, 0, 6, 'keyword'], [1, 7, 8, 'number'], [1, 9, 10, 'name'],
            [2, 0, 5, 'keyword'], [2, 6, 7, 'name'], [2, 8, 9, 'punctuation'],
            [3, 2, 4, 'word'], [3, 5, 8, 'word'], [3, 9, 14, 'word'],
            [4, 0, 1, 'punctuation']],
    ],
    // Lexical classes on an abandoned line: operators, a dotted word, a number and a string.
    'abandoned-lexical-classes' => [
        "dbspec 1 d\n-> <> <= >= = a.b 1.5 'x''y' \n",
        [[1, 0, 6, 'keyword'], [1, 7, 8, 'number'], [1, 9, 10, 'name'],
            [2, 0, 1, 'operator'], [2, 1, 2, 'operator'], [2, 3, 5, 'operator'], [2, 6, 8, 'operator'],
            [2, 9, 11, 'operator'], [2, 12, 13, 'operator'], [2, 14, 17, 'word'], [2, 18, 21, 'number'],
            [2, 22, 28, 'string']],
    ],
    // A comment line: one comment token from its # to the line end, after its leading spaces.
    'comment-line' => [
        "dbspec 1 d\n  # a note\n",
        [[1, 0, 6, 'keyword'], [1, 7, 8, 'number'], [1, 9, 10, 'name'],
            [2, 2, 10, 'comment']],
    ],
    // R2 and R7: a tab is an offending character and its line is abandoned; the rest of the line is lexed.
    'tab-abandons-line' => [
        "dbspec 1 d\n\tuse x\n",
        [[1, 0, 6, 'keyword'], [1, 7, 8, 'number'], [1, 9, 10, 'name'],
            [2, 1, 4, 'word'], [2, 5, 6, 'word']],
    ],
    // The shared encoding case: the lines before the encoding stop keep their parse classes, and the
    // stop line and the lines after it are lexical (R8, R17).
    'encoding-after-a-syntax-error' => [
        "dbspec 1 d\n\ntable t {\n  id i64 bogus\n  primary key (id)\n}\n\n# x\ry",
        [[1, 0, 6, 'keyword'], [1, 7, 8, 'number'], [1, 9, 10, 'name'],
            [3, 0, 5, 'keyword'], [3, 6, 7, 'name'], [3, 8, 9, 'punctuation'],
            [4, 2, 4, 'word'], [4, 5, 8, 'word'], [4, 9, 14, 'word'],
            [5, 2, 9, 'keyword'], [5, 10, 13, 'keyword'], [5, 14, 15, 'punctuation'], [5, 15, 17, 'name'], [5, 17, 18, 'punctuation'],
            [6, 0, 1, 'punctuation'],
            [8, 0, 5, 'comment']],
    ],
    // R15 and R7: an invalid UTF-8 byte is one column and gives no token; the stop line is lexical.
    'invalid-byte-stop-line' => [
        "dbspec 1 d\n table \xff t {\n",
        [[1, 0, 6, 'keyword'], [1, 7, 8, 'number'], [1, 9, 10, 'name'],
            [2, 1, 6, 'word'], [2, 9, 10, 'word'], [2, 11, 12, 'punctuation']],
    ],
    // R21: a byte order mark is an offending character that counts one column; the stop line is lexical.
    'byte-order-mark-stop' => [
        "\xEF\xBB\xBFdbspec 1 d\n",
        [[1, 1, 7, 'word'], [1, 8, 9, 'number'], [1, 10, 11, 'word']],
    ],
];
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

