<?php
declare(strict_types=1);
// Runs dbspec cases in the shape of tests/dbspec/cases.json: canonical cases
// emit unchanged, normalize cases emit their canonical lines, invalid cases
// report exactly the listed errors in order. Each case reports its start,
// result and elapsed time and has its own deadline.

/** @param array<string, list<string>> $lines */
function dbspec_documents(array $documents, bool $crlf): array
{
    $end = $crlf ? "\r\n" : "\n";
    $texts = [];
    foreach ($documents as $name => $lines) {
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
        echo "RUN $id\n";
        $started = hrtime(true);
        $texts = dbspec_documents($case['documents'], $case['crlf'] ?? false);
        $text = $texts[$case['main']];
        $result = Orm\Dbspec\Dbspec::parse($text, $texts);
        if ($kind === 'invalid') {
            if ($result->document !== null) {
                throw new RuntimeException("$id: a document was returned with diagnostics expected");
            }
            $got = array_map(static fn(Orm\Dbspec\Diagnostic $d): array => ['line' => $d->line, 'column' => $d->column, 'rule' => $d->rule], $result->diagnostics);
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
            $emitted = Orm\Dbspec\Dbspec::emit($result->document);
            if ($emitted !== $want) {
                throw new RuntimeException("$id: emission differs\n--- want\n$want--- got\n$emitted");
            }
            $again = Orm\Dbspec\Dbspec::parse($emitted, $texts);
            if ($again->document === null || Orm\Dbspec\Dbspec::emit($again->document) !== $emitted) {
                throw new RuntimeException("$id: emission is not idempotent");
            }
        }
        $elapsed = (hrtime(true) - $started) / 1e6;
        if ($elapsed > $deadlineSeconds * 1000) {
            throw new RuntimeException("$id: deadline of {$deadlineSeconds} s exceeded ($elapsed ms)");
        }
        echo "PASS $id elapsedMs=$elapsed\n";
        $passed++;
    }
    return $passed;
}
