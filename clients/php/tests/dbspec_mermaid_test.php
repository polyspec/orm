<?php
declare(strict_types=1);
// Runs the export, import, invalid and round trip cases of
// tests/dbspec/mermaid.json through Orm\Dbspec\Dbspec::exportMermaid and
// ::importMermaid (docs/mermaid.md): the Mermaid text, the emitted document,
// the dropped [kind, table, name] and the [rule, line, column] diagnostics
// must equal the case, and a round trip gets back the tables, columns,
// primary keys and foreign keys of its document. Each case reports its
// start, result and elapsed time against its deadline.
// Usage: php clients/php/tests/dbspec_mermaid_test.php
require __DIR__ . '/autoload.php';
require_once __DIR__ . '/case_clock.php';

use Orm\Dbspec\Dbspec;
use Orm\Dbspec\Diagnostic;
use Orm\Dbspec\Document;
use Orm\Dbspec\Unsupported;

const CASE_DEADLINE_MS = 5000;

$started = hrtime(true);
echo "RUN dbspec_mermaid\n";
$vectors = json_decode(file_get_contents(dirname(__DIR__, 3) . '/tests/dbspec/mermaid.json'), true, 512, JSON_THROW_ON_ERROR);
if ($vectors['version'] !== 1 || $vectors['export'] === [] || $vectors['import'] === [] || $vectors['invalid'] === [] || $vectors['round_trip'] === []) {
    throw new RuntimeException('tests/dbspec/mermaid.json has no export, import, invalid or round trip cases of version 1');
}
$join = static fn(array $lines): string => implode("\n", $lines) . "\n";
$drops = static fn(array $dropped): array => array_map(static fn(Unsupported $u): array => [$u->kind, $u->table, $u->name], $dropped);

/** @param Closure(): void $check */
function mermaid_case(string $id, Closure $check): void
{
    $caseStarted = caseClockStart();
    echo "RUN mermaid/$id deadlineMs=" . CASE_DEADLINE_MS . "\n";
    $check();
    [$cpuMs, $wallMs] = caseClockElapsed($caseStarted);
    if ($cpuMs > CASE_DEADLINE_MS) {
        throw new RuntimeException("mermaid/$id: CPU deadline of " . CASE_DEADLINE_MS . " ms exceeded ($cpuMs ms CPU, $wallMs ms wall)");
    }
    echo "PASS mermaid/$id cpuMs=$cpuMs wallMs=$wallMs\n";
}

function mermaid_equal(string $what, mixed $want, mixed $got): void
{
    if ($got !== $want) {
        throw new RuntimeException("$what\n--- want\n" . (is_string($want) ? $want : json_encode($want)) . "\n--- got\n" . (is_string($got) ? $got : json_encode($got)));
    }
}

/**
 * Mermaid 가 옮기는 table, column, primary key, foreign key 를 table 이름 순서의 줄로 쓴다.
 * foreign key action 은 Mermaid 가 옮기지 않으므로 뺀다.
 *
 * @return list<string>
 */
function mermaid_skeleton(Document $d): array
{
    $tables = $d->tables;
    usort($tables, static fn($a, $b): int => strcmp($a->name, $b->name));
    $out = [];
    foreach ($tables as $t) {
        $out[] = "table {$t->name}";
        foreach ($t->columns as $c) {
            $out[] = "column {$c->name} {$c->type->text()} null=" . ($c->nullable ? 'true' : 'false') . ' identity=' . ($c->identity ? 'true' : 'false') . ' default=' . ($c->default ?? '-');
        }
        $out[] = 'primary key ' . implode(', ', $t->primaryKey->columns);
        $foreignKeys = $t->foreignKeys;
        usort($foreignKeys, static fn($a, $b): int => strcmp($a->name, $b->name));
        foreach ($foreignKeys as $f) {
            $out[] = "foreign key {$f->name} (" . implode(', ', $f->columns) . ") references {$f->table} (" . implode(', ', $f->referencedColumns) . ')';
        }
    }
    return $out;
}

$cases = 0;
foreach ($vectors['export'] as $case) {
    mermaid_case("export/{$case['id']}", static function () use ($case, $join, $drops): void {
        $parsed = Dbspec::parse($join($case['document']), array_map($join, $case['documents']));
        if ($parsed->document === null) {
            throw new RuntimeException("export/{$case['id']}: " . json_encode($parsed->diagnostics));
        }
        $result = Dbspec::exportMermaid($parsed->document);
        mermaid_equal("export/{$case['id']} mermaid", $join($case['mermaid']), $result->text);
        mermaid_equal("export/{$case['id']} dropped", $case['dropped'], $drops($result->dropped));
    });
    $cases++;
}
foreach ($vectors['import'] as $case) {
    mermaid_case("import/{$case['id']}", static function () use ($case, $join, $drops): void {
        $result = Dbspec::importMermaid($join($case['mermaid']), 'imported');
        if ($result->document === null) {
            throw new RuntimeException("import/{$case['id']}: " . json_encode($result->diagnostics));
        }
        mermaid_equal("import/{$case['id']} document", $join($case['document']), Dbspec::emit($result->document));
        mermaid_equal("import/{$case['id']} dropped", $case['dropped'], $drops($result->dropped));
    });
    $cases++;
}
foreach ($vectors['invalid'] as $case) {
    mermaid_case("invalid/{$case['id']}", static function () use ($case, $join): void {
        $result = Dbspec::importMermaid($join($case['mermaid']), 'imported');
        if ($result->document !== null) {
            throw new RuntimeException("invalid/{$case['id']}: imported a document");
        }
        $got = array_map(static fn(Diagnostic $d): array => [$d->rule, $d->line, $d->column], $result->diagnostics);
        mermaid_equal("invalid/{$case['id']} errors", $case['errors'], $got);
    });
    $cases++;
}
foreach ($vectors['round_trip'] as $case) {
    mermaid_case("round_trip/{$case['id']}", static function () use ($case, $drops): void {
        $read = Dbspec::readFile(dirname(__DIR__, 3) . '/' . $case['path']);
        if ($read->text === null) {
            throw new RuntimeException("round_trip/{$case['id']}: " . json_encode($read->diagnostics));
        }
        $parsed = Dbspec::parse($read->text, []);
        if ($parsed->document === null) {
            throw new RuntimeException("round_trip/{$case['id']}: " . json_encode($parsed->diagnostics));
        }
        $exported = Dbspec::exportMermaid($parsed->document);
        mermaid_equal("round_trip/{$case['id']} export dropped", $case['dropped'], $drops($exported->dropped));
        $imported = Dbspec::importMermaid($exported->text, $parsed->document->name);
        if ($imported->document === null) {
            throw new RuntimeException("round_trip/{$case['id']}: " . json_encode($imported->diagnostics));
        }
        mermaid_equal("round_trip/{$case['id']} import dropped", $case['imported'], $drops($imported->dropped));
        mermaid_equal("round_trip/{$case['id']} tables", implode("\n", mermaid_skeleton($parsed->document)), implode("\n", mermaid_skeleton($imported->document)));
        echo "round_trip/{$case['id']} exported=" . count($exported->dropped) . ' imported=' . count($imported->dropped) . "\n";
    });
    $cases++;
}
echo "PASS dbspec_mermaid cases=$cases elapsedMs=" . ((hrtime(true) - $started) / 1e6) . "\n";
