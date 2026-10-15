<?php
declare(strict_types=1);
require_once __DIR__ . '/case_clock.php';
require_once dirname(__DIR__, 3) . '/tests/dbspec/cases.php';

use PHPUnit\Framework\Assert;

// Checks dbspec cases in the shape of tests/dbspec/cases.json with the PHPUnit
// assertions; the test classes run each case as one data set named by its id.

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

/**
 * Checks one case of a kind (canonical, normalize, invalid) with the PHPUnit assertions: a canonical case emits
 * unchanged, a normalize case emits its canonical lines, an invalid case reports exactly the listed errors in order. The
 * case's CPU time is measured against its reference $cpuSeconds (case_clock.php).
 */
function dbspec_check_case(string $kind, array $case, float $cpuSeconds): void
{
    $id = $kind . '/' . $case['id'];
    $clock = cpuCaseBegin($cpuSeconds);
    $texts = dbspec_documents($case['documents'], $case['crlf'] ?? false, $case['mixed'] ?? false);
    $text = $texts[$case['main']];
    $result = Polyspec\Orm\Dbspec\Dbspec::parse($text, $texts);
    if ($kind === 'invalid') {
        Assert::assertNull($result->document, "$id: a document was returned with diagnostics expected");
        Assert::assertNull($result->positions, "$id: positions were returned for an invalid document");
        $got = array_map(static fn(Polyspec\Orm\Dbspec\Diagnostic $d): array => ['line' => $d->line, 'column' => $d->column, 'rule' => $d->rule], $result->diagnostics);
        $want = array_map(static fn(array $e): array => ['line' => $e['line'], 'column' => $e['column'], 'rule' => $e['rule']], $case['errors']);
        Assert::assertSame($want, $got, "$id: diagnostics differ\n" . implode("\n", array_map(static fn($d) => "{$d->line}:{$d->column} {$d->rule} {$d->message}", $result->diagnostics)));
        foreach ($result->diagnostics as $d) {
            Assert::assertNotSame('', $d->message, "$id: empty diagnostic message");
        }
    } else {
        Assert::assertSame([], array_map(static fn($d) => "{$d->line}:{$d->column} {$d->rule} {$d->message}", $result->diagnostics), "$id: unexpected diagnostics");
        Assert::assertNotNull($result->document, "$id: no document");
        $want = $kind === 'canonical' ? implode("\n", $case['documents'][$case['main']]) . "\n" : implode("\n", $case['canonical']) . "\n";
        $emitted = Polyspec\Orm\Dbspec\Dbspec::emit($result->document);
        Assert::assertSame($want, $emitted, "$id: emission differs");
        $again = Polyspec\Orm\Dbspec\Dbspec::parse($emitted, $texts);
        Assert::assertNotNull($again->document, "$id: emission does not parse again");
        Assert::assertSame($emitted, Polyspec\Orm\Dbspec\Dbspec::emit($again->document), "$id: emission is not idempotent");
    }
    cpuCaseEnd($id, $clock);
}


/**
 * The cases of the section $kind as PHPUnit data sets named by their bare ids, the case ids of that suite of
 * config/parity.json, each with its kind and case. A repeated id is refused.
 */
function dbspec_case_ids(string $kind, array $cases): iterable
{
    $seen = [];
    foreach ($cases as $case) {
        if (isset($seen[$case['id']])) {
            throw new RuntimeException("repeated case id $kind/{$case['id']}");
        }
        $seen[$case['id']] = true;
        yield $case['id'] => [$kind, $case];
    }
}
/**
 * The data sets of one kind of cases, each named "<kind>/<id>" and holding [kind, case]. A repeated id is an error.
 *
 * @return iterable<string, array{string, array}>
 */
function dbspec_case_sets(string $kind, array $cases): iterable
{
    $seen = [];
    foreach ($cases as $case) {
        $name = $kind . '/' . $case['id'];
        if (isset($seen[$name])) {
            throw new RuntimeException("repeated case id $name");
        }
        $seen[$name] = true;
        yield $name => [$kind, $case];
    }
}

/**
 * Checks one positions case: it parses its main document and must return the listed positions, in order, with the
 * listed kind, path, line and column. The section is read strictly: a case or position with an unknown or missing field
 * is an error.
 */
function dbspec_check_position_case(array $case, float $cpuSeconds): void
{
    Assert::assertSame(['id', 'documents', 'main', 'positions'], array_keys($case), 'positions case has unexpected fields');
    $id = 'positions/' . $case['id'];
    $clock = cpuCaseBegin($cpuSeconds);
    $texts = dbspec_documents($case['documents'], false);
    $result = Polyspec\Orm\Dbspec\Dbspec::parse($texts[$case['main']], $texts);
    Assert::assertTrue($result->document !== null && $result->diagnostics === [], "$id: parse failed");
    $got = [];
    foreach ($result->positions as $p) {
        $got[] = ['kind' => $p->kind, 'path' => $p->path, 'line' => $p->line, 'column' => $p->column];
    }
    $want = [];
    foreach ($case['positions'] as $p) {
        Assert::assertSame(['kind', 'path', 'line', 'column'], array_keys($p), "$id: position has unexpected fields");
        $want[] = $p;
    }
    Assert::assertSame($want, $got, "$id: positions differ");
    cpuCaseEnd($id, $clock);
}
