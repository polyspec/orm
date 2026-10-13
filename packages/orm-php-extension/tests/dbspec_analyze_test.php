<?php
declare(strict_types=1);

// The extension orm_dbspec (Polyspec\Orm\Dbspec\Native) against the PHP client for syntax analysis and formatting
// (docs/dbspec.md "Syntax analysis", "Formatting"): the focused cases, the shared cases of tests/dbspec/cases.json and a
// limit stop give the same tokens, positions, diagnostics, emission and formatted text as the PHP client.
//
// Usage: php -d extension=<orm_dbspec library> packages/orm-php-extension/tests/dbspec_analyze_test.php

use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Native\Dbspec as NativeDbspec;

$root = dirname(__DIR__, 3);
require "$root/packages/orm-php/tests/autoload.php";
require "$root/packages/orm-php/tests/case_clock.php";
require "$root/packages/orm-php/tests/dbspec_cases.php";
require "$root/packages/orm-php/tests/dbspec_analysis_cases.php";
require "$root/packages/orm-php/tests/dbspec_syntax_vectors.php";

if (!extension_loaded('orm_dbspec')) {
    fwrite(STDERR, "the extension orm_dbspec is not loaded; run make dbspec-php-extension-check, which builds and loads it\n");
    exit(1);
}

/** The comparable form of an analysis: tokens, positions, diagnostics, emission. */
function analysis_view(object $analysis, string $emitter): array
{
    return [
        'tokens' => array_map(static fn(object $t): array => [$t->line, $t->start, $t->end, $t->class], $analysis->tokens),
        'positions' => $analysis->positions === null ? null : array_map(static fn(object $p): array => [$p->kind, $p->path, $p->line, $p->column], $analysis->positions),
        'diagnostics' => array_map(static fn(object $d): array => [$d->rule, $d->line, $d->column, $d->message], $analysis->diagnostics),
        'emission' => $analysis->document === null ? null : $emitter::emit($analysis->document),
    ];
}

function same(string $what, mixed $want, mixed $got): void
{
    if ($want !== $got) {
        throw new RuntimeException("$what: the extension differs from the PHP client\nwant " . json_encode($want) . "\ngot  " . json_encode($got));
    }
}

/** Runs one case of the analysis and the format on both implementations and compares them. */
function same_analysis(string $id, string $text, array $documents): void
{
    $clock = cpuCaseBegin("php-extension/analyze/$id", 2.0);
    $php = Dbspec::analyze($text, $documents);
    $native = NativeDbspec::analyze($text, $documents);
    same("$id analysis", analysis_view($php, Dbspec::class), analysis_view($native, NativeDbspec::class));
    $phpFormat = Dbspec::format($text, $documents);
    $nativeFormat = NativeDbspec::format($text, $documents);
    same("$id format text", $phpFormat->text, $nativeFormat->text);
    same("$id format diagnostics", array_map(static fn(object $d): array => [$d->rule, $d->line, $d->column, $d->message], $phpFormat->diagnostics), array_map(static fn(object $d): array => [$d->rule, $d->line, $d->column, $d->message], $nativeFormat->diagnostics));
    cpuCaseEnd("php-extension/analyze/$id", $clock);
}

$counts = ['focused' => 0, 'shared' => 0, 'limit' => 0];
foreach (dbspec_analysis_focused_cases() as $id => [$text, $want]) {
    same_analysis("focused/$id", $text, ['d' => $text]);
    $native = array_map(static fn(object $t): array => [$t->line, $t->start, $t->end, $t->class], NativeDbspec::analyze($text, ['d' => $text])->tokens);
    same("focused/$id tokens", $want, $native);
    $counts['focused']++;
}

$cases = json_decode((string) file_get_contents("$root/tests/dbspec/cases.json"), true, 512, JSON_THROW_ON_ERROR);
foreach (['canonical', 'normalize', 'invalid'] as $kind) {
    foreach ($cases[$kind] as $case) {
        $texts = dbspec_documents($case['documents'], $case['crlf'] ?? false, $case['mixed'] ?? false);
        same_analysis("$kind/" . $case['id'], $texts[$case['main']], $texts);
        $counts['shared']++;
    }
}

$lines = [];
for ($i = 1; $i <= 4097; $i++) {
    $lines[] = "table t$i {";
    $lines[] = '}';
}
$limitText = "dbspec 1 d\n" . implode("\n", $lines) . "\n";
same_analysis('limit', $limitText, ['d' => $limitText]);
same('limit tokens', [], NativeDbspec::analyze($limitText, ['d' => $limitText])->tokens);
$counts['limit']++;

// Argument errors: a document set entry that is not a name and text throws as the PHP client does.
foreach (['analyze', 'format'] as $method) {
    $message = [];
    foreach ([Dbspec::class, NativeDbspec::class] as $class) {
        try {
            $class::$method('dbspec 1 d', ['d' => 5]);
            $message[] = 'no exception';
        } catch (InvalidArgumentException $e) {
            $message[] = get_class($e) . ': ' . $e->getMessage();
        }
    }
    same("$method argument error", $message[0], $message[1]);
}

echo json_encode($counts) . "\n";

// The shared syntax vectors: the native tokens of every case of tests/dbspec/syntax.json, exactly.
$syntaxCount = dbspec_syntax_check(
    dbspec_syntax_load($root),
    dbspec_syntax_inputs($cases),
    static fn(string $text, array $documents): array => array_map(static fn(object $t): array => [$t->line, $t->start, $t->end, $t->class], NativeDbspec::analyze($text, $documents)->tokens),
);
echo "syntax.json: $syntaxCount cases match\n";
