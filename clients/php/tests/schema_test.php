<?php
// Schema tool test: every Mermaid fixture of tests/schema/cases.json builds,
// renders DDL, diffs, and plans to the same text, or fails with the same
// message, as the Go tooling.
// Usage: php clients/php/tests/schema_test.php
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use Orm\SchemaBuilder;
use Orm\SchemaDdl;
use Orm\SchemaDiff;
use Orm\SchemaPlan;
use Orm\SchemaError;
use Orm\SchemaParser;

$root = dirname(__DIR__, 3);
$failures = 0;
$cases = 0;

function build(string $src): string
{
    try {
        return SchemaBuilder::json(SchemaBuilder::build([SchemaParser::parse($src)]));
    } catch (SchemaError $e) {
        return 'error: ' . $e->getMessage() . "\n";
    }
}

$bench = SchemaBuilder::json(SchemaBuilder::fromSources([(string) file_get_contents("$root/schema/bench.mmd")]));
$cases++;
if ($bench !== file_get_contents("$root/schema/schema.json")) {
    $failures++;
    fwrite(STDERR, "FAIL schema/bench.mmd: differs from schema/schema.json\n");
}
$loaded = SchemaBuilder::load($bench);
$cases++;
if (SchemaBuilder::json($loaded) !== $bench) {
    $failures++;
    fwrite(STDERR, "FAIL load: schema.json does not round-trip\n");
}
try {
    SchemaBuilder::load(str_replace('"battle"', '"battles"', $bench));
    $failures++;
    fwrite(STDERR, "FAIL load: an edited schema.json was accepted\n");
} catch (InvalidArgumentException) {
}

// tests/schema/cases.json holds the Go results for the Mermaid fixtures of
// the Go test suites: the manifest, the DDL of each dialect, the migration
// between manifests, and the migration plan file, as digests or errors.
$recorded = json_decode((string) file_get_contents("$root/tests/schema/cases.json"), true);

/** @return array{sha256?: string, error?: string} */
function digest(Closure $render): array
{
    try {
        return ['sha256' => hash('sha256', $render())];
    } catch (SchemaError|RuntimeException|InvalidArgumentException $e) {
        return ['error' => $e->getMessage()];
    }
}

function expect(string $label, array $want, array $got): void
{
    global $cases, $failures;
    $cases++;
    if ($got !== $want) {
        $failures++;
        fwrite(STDERR, "FAIL $label\n--- want " . json_encode($want) . "\n--- got  " . json_encode($got) . "\n");
    }
}

$manifests = [];
foreach ($recorded['cases'] as $case) {
    $m = null;
    $got = digest(static function () use ($case, &$m): string {
        $m = SchemaBuilder::build([SchemaParser::parse($case['mmd'])]);
        return rtrim(SchemaBuilder::json($m), "\n");
    });
    expect("{$case['name']} manifest", $case['manifest'], $got);
    if ($m === null) {
        continue;
    }
    $manifests[$case['name']] = $m;
    foreach ($case['ddl'] as $dialect => $want) {
        expect("{$case['name']} ddl $dialect", $want, digest(static fn(): string => SchemaDdl::render($m, $dialect)));
    }
}
foreach ($recorded['diffs'] as $d) {
    $got = digest(static fn(): string => SchemaDiff::render($manifests[$d['from']], $manifests[$d['to']], $d['dialect'], $d['allow_destructive']));
    $allow = $d['allow_destructive'] ? ' --allow-destructive' : '';
    expect("diff {$d['from']} -> {$d['to']} {$d['dialect']}$allow", array_diff_key($d, array_flip(['from', 'to', 'dialect', 'allow_destructive'])), $got);
}
foreach ($recorded['plans'] as $p) {
    $got = digest(static fn(): string => SchemaPlan::render($manifests[$p['from']], $manifests[$p['to']], $p['dialect'], $recorded['plan_id'], $recorded['plan_name']));
    expect("plan {$p['from']} -> {$p['to']} {$p['dialect']}", array_diff_key($p, array_flip(['from', 'to', 'dialect'])), $got);
}

if ($failures > 0) {
    fwrite(STDERR, "php schema test: $failures of $cases cases failed\n");
    exit(1);
}
echo "php schema test: $cases cases passed\n";
