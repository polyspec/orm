<?php
declare(strict_types=1);
// The hashes cases of tests/dbspec/cases.json and the repeated document name
// rule through Orm\Dbspec\Dbspec::manifest.
require __DIR__ . '/autoload.php';

use Orm\Dbspec\Dbspec;
use Orm\Dbspec\Document;

$started = hrtime(true);
echo "RUN dbspec_manifest\n";
$root = dirname(__DIR__, 3);
$cases = json_decode(file_get_contents("$root/tests/dbspec/cases.json"), true, 512, JSON_THROW_ON_ERROR);
if (($cases['hashes'] ?? []) === []) {
    throw new RuntimeException('Missing hashes vectors');
}

/** @param list<string> $lines */
function manifest_text(array $lines): string
{
    return implode("\n", $lines) . "\n";
}

/** @param list<string> $lines */
function manifest_parsed(string $id, array $lines, array $set): Document
{
    $result = Dbspec::parse(manifest_text($lines), $set);
    if ($result->document === null) {
        throw new RuntimeException("$id: diagnostics " . json_encode(array_map(fn($d) => [$d->rule, $d->line, $d->column], $result->diagnostics)));
    }
    return $result->document;
}

/** @param list<Document> $documents */
function manifest_expect(array $case, array $documents): void
{
    $result = Dbspec::manifest($documents);
    if ($result->manifest === null) {
        throw new RuntimeException("{$case['id']}: diagnostics " . json_encode(array_map(fn($d) => [$d->rule, $d->line, $d->column], $result->diagnostics)));
    }
    $m = $result->manifest;
    foreach ([
        'manifestText' => [$m->manifestText, manifest_text($case['manifestText'])],
        'schemaText' => [$m->schemaText, manifest_text($case['schemaText'])],
        'manifestHash' => [$m->manifestHash, $case['manifestHash']],
        'schemaHash' => [$m->schemaHash, $case['schemaHash']],
    ] as $field => [$got, $want]) {
        if ($got !== $want) {
            throw new RuntimeException("{$case['id']}: $field differs\n--- want\n$want\n--- got\n$got");
        }
    }
}

foreach ($cases['hashes'] as $case) {
    $caseStarted = hrtime(true);
    echo "RUN hashes/{$case['id']}\n";
    $names = array_keys($case['documents']);
    sort($names, SORT_STRING);
    $documents = [];
    foreach ($names as $name) {
        $set = [];
        foreach ($case['documents'] as $other => $lines) {
            if ($other !== $name) {
                $set[$other] = manifest_text($lines);
            }
        }
        $documents[] = manifest_parsed("{$case['id']}/$name", $case['documents'][$name], $set);
    }
    manifest_expect($case, $documents);
    // The set is ordered by document name, not by the order given.
    manifest_expect($case, array_reverse($documents));
    echo "PASS hashes/{$case['id']} elapsedMs=" . ((hrtime(true) - $caseStarted) / 1e6) . "\n";
}

echo "RUN manifest/repeated-name\n";
$text = ['dbspec 1 shop', '', 'table users {', '  id i64 identity', '  primary key (id)', '}'];
$result = Dbspec::manifest([manifest_parsed('repeated', $text, []), manifest_parsed('repeated', $text, [])]);
$got = array_map(fn($d) => [$d->rule, $d->line, $d->column], $result->diagnostics);
if ($result->manifest !== null || $got !== [['name.duplicate', 1, 10]]) {
    throw new RuntimeException('repeated document name: ' . json_encode($got));
}
echo "PASS manifest/repeated-name\n";

$elapsed = (hrtime(true) - $started) / 1e6;
if ($elapsed > 10000) {
    throw new RuntimeException("dbspec_manifest deadline of 10 s exceeded ($elapsed ms)");
}
echo 'PASS dbspec_manifest hashes=' . count($cases['hashes']) . " elapsedMs=$elapsed\n";
