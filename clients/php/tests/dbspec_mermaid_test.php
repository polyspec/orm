<?php
declare(strict_types=1);
// Runs the export, import and invalid cases of tests/dbspec/mermaid.json
// through Orm\Dbspec\Dbspec::exportMermaid and ::importMermaid
// (docs/mermaid.md): the Mermaid text, the emitted document, the dropped
// [kind, table, name] and the [rule, line, column] diagnostics must equal the
// case. Each case reports its start, result and elapsed time against its
// deadline.
// Usage: php clients/php/tests/dbspec_mermaid_test.php
require __DIR__ . '/autoload.php';

use Orm\Dbspec\Dbspec;
use Orm\Dbspec\Diagnostic;
use Orm\Dbspec\Unsupported;

const CASE_DEADLINE_MS = 5000;

$started = hrtime(true);
echo "RUN dbspec_mermaid\n";
$vectors = json_decode(file_get_contents(dirname(__DIR__, 3) . '/tests/dbspec/mermaid.json'), true, 512, JSON_THROW_ON_ERROR);
if ($vectors['version'] !== 1 || $vectors['export'] === [] || $vectors['import'] === [] || $vectors['invalid'] === []) {
    throw new RuntimeException('tests/dbspec/mermaid.json has no export, import or invalid cases of version 1');
}
$join = static fn(array $lines): string => implode("\n", $lines) . "\n";
$drops = static fn(array $dropped): array => array_map(static fn(Unsupported $u): array => [$u->kind, $u->table, $u->name], $dropped);

/** @param Closure(): void $check */
function mermaid_case(string $id, Closure $check): void
{
    $caseStarted = hrtime(true);
    echo "RUN mermaid/$id deadlineMs=" . CASE_DEADLINE_MS . "\n";
    $check();
    $elapsed = (hrtime(true) - $caseStarted) / 1e6;
    if ($elapsed > CASE_DEADLINE_MS) {
        throw new RuntimeException("mermaid/$id: deadline of " . CASE_DEADLINE_MS . " ms exceeded ($elapsed ms)");
    }
    echo "PASS mermaid/$id elapsedMs=$elapsed\n";
}

function mermaid_equal(string $what, mixed $want, mixed $got): void
{
    if ($got !== $want) {
        throw new RuntimeException("$what\n--- want\n" . (is_string($want) ? $want : json_encode($want)) . "\n--- got\n" . (is_string($got) ? $got : json_encode($got)));
    }
}

$cases = 0;
foreach ($vectors['export'] as $case) {
    mermaid_case("export/{$case['id']}", static function () use ($case, $join, $drops): void {
        $parsed = Dbspec::parse($join($case['document']), []);
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
echo "PASS dbspec_mermaid cases=$cases elapsedMs=" . ((hrtime(true) - $started) / 1e6) . "\n";
