<?php
declare(strict_types=1);
// The hashes cases of tests/dbspec/cases.json and the repeated document name
// rule through Orm\Dbspec\Dbspec::manifest, and the sets cases through
// Dbspec::manifest and Dbspec::render in every dialect.
require __DIR__ . '/autoload.php';
require_once __DIR__ . '/case_clock.php';

use Orm\Dbspec\Dbspec;
use Orm\Dbspec\Document;

$started = caseClockStart();
$root = dirname(__DIR__, 3);
$cases = json_decode(file_get_contents("$root/tests/dbspec/cases.json"), true, 512, JSON_THROW_ON_ERROR);
if (($cases['hashes'] ?? []) === []) {
    throw new RuntimeException('Missing hashes vectors');
}
if (($cases['sets'] ?? []) === []) {
    throw new RuntimeException('Missing sets vectors');
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
    // 각 case는 memory 안에서 문서 집합 하나의 manifest와 hash를 만든다.
    testcase_begin("hashes/{$case['id']}", TESTCASE_COMPUTE);
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
    testcase_end();
}

/** 줄을 LF로 잇는다. 줄이 없으면 빈 text다. @param list<string> $lines */
function set_text(array $lines): string
{
    return $lines === [] ? '' : manifest_text($lines);
}

/**
 * statement 가운데 CREATE TABLE이 만드는 table 이름이다.
 *
 * @param list<string> $statements
 * @return list<string>
 */
function created_tables(array $statements): array
{
    $out = [];
    foreach ($statements as $statement) {
        if (str_starts_with($statement, 'CREATE TABLE ')) {
            $name = explode(' ', substr($statement, strlen('CREATE TABLE ')), 2)[0];
            $out[] = trim($name, '`"');
        }
    }
    return $out;
}

foreach ($cases['sets'] as $case) {
    testcase_begin("sets/{$case['id']}", TESTCASE_COMPUTE);
    // 각 문서는 다른 소유 문서, 외부 문서(external), parsing 문서(헤더 이름이 키)를 집합으로 파싱한다.
    // 외부 문서는 external로 표시한다.
    $all = array_merge($case['documents'], $case['external'] ?? []);
    $owned = count($case['documents']);
    $names = [];
    foreach ($all as $i => $lines) {
        if (preg_match('/\Adbspec 1 ([A-Za-z0-9_]+)\z/', $lines[0] ?? '', $m) !== 1) {
            throw new RuntimeException("{$case['id']}: document $i has no header name");
        }
        $names[$i] = $m[1];
    }
    $documents = [];
    foreach ($all as $i => $lines) {
        $set = array_map(manifest_text(...), $case['parsing']);
        foreach ($all as $j => $otherLines) {
            if ($j !== $i) {
                $set[$names[$j]] = manifest_text($otherLines);
            }
        }
        $document = manifest_parsed("{$case['id']}/$i", $lines, $set);
        $document->external = $i >= $owned;
        $documents[] = $document;
    }
    $want = array_map(fn($e) => [$e['rule'], $e['line'], $e['column']], $case['errors']);
    $result = Dbspec::manifest($documents);
    $got = array_map(fn($d) => [$d->rule, $d->line, $d->column], $result->diagnostics);
    if ($got !== $want || ($want === []) !== ($result->manifest !== null)) {
        throw new RuntimeException("{$case['id']}: manifest diagnostics " . json_encode($got) . ' want ' . json_encode($want));
    }
    $expected = $case['manifest'] ?? null;
    if ($expected !== null) {
        $m = $result->manifest;
        foreach ([
            'manifestText' => [$m->manifestText, set_text($expected['manifestText'])],
            'externalText' => [$m->externalText, set_text($expected['externalText'])],
            'schemaText' => [$m->schemaText, set_text($expected['schemaText'])],
            'manifestHash' => [$m->manifestHash, $expected['manifestHash']],
            'schemaHash' => [$m->schemaHash, $expected['schemaHash']],
        ] as $field => [$gotText, $wantText]) {
            if ($gotText !== $wantText) {
                throw new RuntimeException("{$case['id']}: $field differs\n--- want\n$wantText\n--- got\n$gotText");
            }
        }
    }
    foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
        $rendered = Dbspec::render($documents, $dialect);
        $got = array_map(fn($d) => [$d->rule, $d->line, $d->column], $rendered->diagnostics);
        if ($got !== $want || ($want === []) !== ($rendered->statements !== null)) {
            throw new RuntimeException("{$case['id']}/$dialect: render diagnostics " . json_encode($got) . ' want ' . json_encode($want));
        }
        if ($expected !== null && ($created = created_tables($rendered->statements)) !== $expected['created']) {
            throw new RuntimeException("{$case['id']}/$dialect: render creates " . json_encode($created) . ' want ' . json_encode($expected['created']));
        }
    }
    testcase_end();
}

testcase_begin('manifest/repeated-name', TESTCASE_COMPUTE);
$text = ['dbspec 1 shop', '', 'table users {', '  id i64 identity', '  primary key (id)', '}'];
$result = Dbspec::manifest([manifest_parsed('repeated', $text, []), manifest_parsed('repeated', $text, [])]);
$got = array_map(fn($d) => [$d->rule, $d->line, $d->column], $result->diagnostics);
if ($result->manifest !== null || $got !== [['name.duplicate', 1, 10]]) {
    throw new RuntimeException('repeated document name: ' . json_encode($got));
}
testcase_end();

// 모든 case를 합친 CPU 시간도 10 s 한도를 가진다.
testcase_begin('dbspec_manifest/cpu-total', TESTCASE_COMPUTE);
[$cpuMs, $wallMs] = caseClockElapsed($started);
if ($cpuMs > 10000) {
    throw new RuntimeException("dbspec_manifest CPU deadline of 10 s exceeded ($cpuMs ms CPU, $wallMs ms wall)");
}
testcase_step('hashes=' . count($cases['hashes']) . ' sets=' . count($cases['sets']) . " cpuMs=$cpuMs wallMs=$wallMs");
testcase_end();
