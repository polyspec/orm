<?php
declare(strict_types=1);
require_once __DIR__ . '/case_clock.php';
// Runs dbspec cases in the shape of tests/dbspec/cases.json: canonical cases
// emit unchanged, normalize cases emit their canonical lines, invalid cases
// report exactly the listed errors in order. Each case reports its start,
// result and elapsed time and has its own deadline.

/**
 * Joins each document's lines with LF, with CRLF when $crlf is true, or
 * alternately CRLF and LF (starting with CRLF, no final line end) when
 * $mixed is true.
 *
 * @param array<string, list<string>> $documents
 */
function dbspec_documents(array $documents, bool $crlf, bool $mixed = false): array
{
    $texts = [];
    foreach ($documents as $name => $lines) {
        if ($mixed) {
            $text = '';
            foreach ($lines as $i => $line) {
                $text .= ($i > 0 ? ($i % 2 === 1 ? "\r\n" : "\n") : '') . $line;
            }
            $texts[$name] = $text;
            continue;
        }
        $end = $crlf ? "\r\n" : "\n";
        $texts[$name] = implode($end, $lines) . $end;
    }
    return $texts;
}

/** Runs one kind of cases and returns how many passed; throws on the first failure. */
function dbspec_run_cases(string $kind, array $cases, float $deadlineSeconds): int
{
    $passed = 0;
    foreach ($cases as $case) {
        $id = $kind . '/' . $case['id'];
        $clock = cpuCaseBegin($id, $deadlineSeconds);
        $texts = dbspec_documents($case['documents'], $case['crlf'] ?? false, $case['mixed'] ?? false);
        $text = $texts[$case['main']];
        $result = Polyspec\Orm\Dbspec\Dbspec::parse($text, $texts);
        if ($kind === 'invalid') {
            if ($result->document !== null) {
                throw new RuntimeException("$id: a document was returned with diagnostics expected");
            }
            $got = array_map(static fn(Polyspec\Orm\Dbspec\Diagnostic $d): array => ['line' => $d->line, 'column' => $d->column, 'rule' => $d->rule], $result->diagnostics);
            $want = array_map(static fn(array $e): array => ['line' => $e['line'], 'column' => $e['column'], 'rule' => $e['rule']], $case['errors']);
            if ($got !== $want) {
                throw new RuntimeException("$id: diagnostics differ\nwant " . json_encode($want) . "\ngot  " . json_encode($got) . "\n" . implode("\n", array_map(static fn($d) => "{$d->line}:{$d->column} {$d->rule} {$d->message}", $result->diagnostics)));
            }
            foreach ($result->diagnostics as $d) {
                if ($d->message === '') {
                    throw new RuntimeException("$id: empty diagnostic message");
                }
            }
        } else {
            if ($result->diagnostics !== [] || $result->document === null) {
                throw new RuntimeException("$id: unexpected diagnostics\n" . implode("\n", array_map(static fn($d) => "{$d->line}:{$d->column} {$d->rule} {$d->message}", $result->diagnostics)));
            }
            $want = $kind === 'canonical' ? implode("\n", $case['documents'][$case['main']]) . "\n" : implode("\n", $case['canonical']) . "\n";
            $emitted = Polyspec\Orm\Dbspec\Dbspec::emit($result->document);
            if ($emitted !== $want) {
                throw new RuntimeException("$id: emission differs\n--- want\n$want--- got\n$emitted");
            }
            $again = Polyspec\Orm\Dbspec\Dbspec::parse($emitted, $texts);
            if ($again->document === null || Polyspec\Orm\Dbspec\Dbspec::emit($again->document) !== $emitted) {
                throw new RuntimeException("$id: emission is not idempotent");
            }
        }
        cpuCaseEnd($id, $clock);
        $passed++;
    }
    return $passed;
}
