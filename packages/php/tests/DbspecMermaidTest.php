<?php
declare(strict_types=1);
// Runs the export, import, invalid and round trip cases of
// tests/dbspec/mermaid.json through Polyspec\Orm\Dbspec\Dbspec::exportMermaid and
// ::importMermaid (docs/spec/mermaid.md): the Mermaid text, the emitted document,
// the dropped [kind, table, name] and the [rule, line, column] diagnostics
// must equal the case, and a round trip gets back the tables, columns,
// primary keys and foreign keys of its document. Each case is a data set
// named by its section and id.
require_once __DIR__ . '/case_clock.php';

use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Diagnostic;
use Polyspec\Orm\Dbspec\Document;
use Polyspec\Orm\Dbspec\Unsupported;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

// CPU time baseline (seconds).
const MERMAID_CASE_CPU_SECONDS = 5.0;

/** The vectors of tests/dbspec/mermaid.json. */
function mermaid_vectors(): array
{
    $vectors = json_decode(file_get_contents(dirname(__DIR__, 3) . '/tests/dbspec/mermaid.json'), true, 512, JSON_THROW_ON_ERROR);
    Assert::assertFalse($vectors['version'] !== 1 || $vectors['export'] === [] || $vectors['import'] === [] || $vectors['invalid'] === [] || $vectors['round_trip'] === [], 'tests/dbspec/mermaid.json has no export, import, invalid or round trip cases of version 1');
    return $vectors;
}

/** @param list<string> $lines */
function mermaid_join(array $lines): string
{
    return implode("\n", $lines) . "\n";
}

/** @param list<Unsupported> $dropped */
function mermaid_drops(array $dropped): array
{
    return array_map(static fn(Unsupported $u): array => [$u->kind, $u->table, $u->name], $dropped);
}


/**
 * Writes the tables, columns, primary keys, and foreign keys that Mermaid carries, as lines in table name order.
 * Foreign key actions are not carried by Mermaid, so they are left out.
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

#[Small]
final class DbspecMermaidTest extends TestCase
{
    public static function exportCases(): iterable
    {
        foreach (mermaid_vectors()['export'] as $case) {
            yield $case['id'] => [$case];
        }
    }

    #[DataProvider('exportCases')]
    public function test_export(array $case): void
    {
        $clock = cpuCaseBegin(MERMAID_CASE_CPU_SECONDS);
        $parsed = Dbspec::parse(mermaid_join($case['document']), array_map(mermaid_join(...), $case['documents']));
        Assert::assertNotNull($parsed->document, "export/{$case['id']}: " . json_encode($parsed->diagnostics));
        $result = Dbspec::exportMermaid($parsed->document);
        Assert::assertSame(mermaid_join($case['mermaid']), $result->text, "export/{$case['id']} mermaid");
        Assert::assertSame($case['dropped'], mermaid_drops($result->dropped), "export/{$case['id']} dropped");
        cpuCaseEnd('mermaid/export/' . $case['id'], $clock);
    }

    public static function importCases(): iterable
    {
        foreach (mermaid_vectors()['import'] as $case) {
            yield $case['id'] => [$case];
        }
    }

    #[DataProvider('importCases')]
    public function test_import(array $case): void
    {
        $clock = cpuCaseBegin(MERMAID_CASE_CPU_SECONDS);
        $result = Dbspec::importMermaid(mermaid_join($case['mermaid']), 'imported');
        Assert::assertNotNull($result->document, "import/{$case['id']}: " . json_encode($result->diagnostics));
        Assert::assertSame(mermaid_join($case['document']), Dbspec::emit($result->document), "import/{$case['id']} document");
        Assert::assertSame($case['dropped'], mermaid_drops($result->dropped), "import/{$case['id']} dropped");
        cpuCaseEnd('mermaid/import/' . $case['id'], $clock);
    }

    public static function invalidCases(): iterable
    {
        foreach (mermaid_vectors()['invalid'] as $case) {
            yield $case['id'] => [$case];
        }
    }

    #[DataProvider('invalidCases')]
    public function test_invalid(array $case): void
    {
        $clock = cpuCaseBegin(MERMAID_CASE_CPU_SECONDS);
        $result = Dbspec::importMermaid(mermaid_join($case['mermaid']), 'imported');
        Assert::assertNull($result->document, "invalid/{$case['id']}: imported a document");
        $got = array_map(static fn(Diagnostic $d): array => [$d->rule, $d->line, $d->column], $result->diagnostics);
        Assert::assertSame($case['errors'], $got, "invalid/{$case['id']} errors");
        cpuCaseEnd('mermaid/invalid/' . $case['id'], $clock);
    }

    public static function roundtripCases(): iterable
    {
        foreach (mermaid_vectors()['round_trip'] as $case) {
            yield $case['id'] => [$case];
        }
    }

    #[DataProvider('roundtripCases')]
    public function test_round_trip(array $case): void
    {
        $clock = cpuCaseBegin(MERMAID_CASE_CPU_SECONDS);
        $read = Dbspec::readFile(dirname(__DIR__, 3) . '/' . $case['path']);
        Assert::assertNotNull($read->text, "round_trip/{$case['id']}: " . json_encode($read->diagnostics));
        $parsed = Dbspec::parse($read->text, []);
        Assert::assertNotNull($parsed->document, "round_trip/{$case['id']}: " . json_encode($parsed->diagnostics));
        $exported = Dbspec::exportMermaid($parsed->document);
        Assert::assertSame($case['dropped'], mermaid_drops($exported->dropped), "round_trip/{$case['id']} export dropped");
        $imported = Dbspec::importMermaid($exported->text, $parsed->document->name);
        Assert::assertNotNull($imported->document, "round_trip/{$case['id']}: " . json_encode($imported->diagnostics));
        Assert::assertSame($case['imported'], mermaid_drops($imported->dropped), "round_trip/{$case['id']} import dropped");
        Assert::assertSame(implode("\n", mermaid_skeleton($parsed->document)), implode("\n", mermaid_skeleton($imported->document)), "round_trip/{$case['id']} tables");
                cpuCaseEnd('mermaid/round_trip/' . $case['id'], $clock);
    }
}
