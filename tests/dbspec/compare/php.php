<?php

declare(strict_types=1);

// 모든 공유 case, stress 문서, statement vector, plan vector, Mermaid vector의 PHP dbspec
// 결과를 tests/dbspec/compare/check.mjs의 줄 형식으로 출력한다.
//
// Usage: php tests/dbspec/compare/php.php <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json>

require __DIR__ . '/../../../clients/php/vendor/autoload.php';
require __DIR__ . '/../input.php';

if ($argc !== 6) {
    fwrite(STDERR, "usage: php tests/dbspec/compare/php.php <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json>\n");
    exit(2);
}

/** vector file의 위치와 문제를 stderr에 쓰고 1로 끝낸다. */
function dbspec_vector_fail(string $path, string $location, string $problem): never
{
    fwrite(STDERR, "$path: $location $problem\n");
    exit(1);
}

/**
 * vector file을 JSON object로 읽고 $read로 모양을 확인해 그 결과를 돌려준다.
 * 빈 object와 빈 array를 구별하도록 object는 stdClass로 읽는다.
 */
function dbspec_read_vectors(string $path, callable $read): array
{
    $text = dbspec_read_input($path);
    try {
        $value = json_decode($text, false, 512, JSON_THROW_ON_ERROR);
    } catch (JsonException $e) {
        fwrite(STDERR, "$path: {$e->getMessage()}\n");
        exit(1);
    }
    if (!$value instanceof stdClass) {
        dbspec_vector_fail($path, '$', 'is not an object');
    }
    return $read($path, $value);
}

/** $object의 $key가 있는지 확인해 그 값을 돌려준다. */
function dbspec_vector_field(string $path, stdClass $object, string $location, string $key): mixed
{
    $at = $location === '' ? $key : "$location.$key";
    if (!property_exists($object, $key)) {
        dbspec_vector_fail($path, $at, 'is missing');
    }
    return $object->$key;
}

function dbspec_vector_string(string $path, stdClass $object, string $location, string $key): string
{
    $value = dbspec_vector_field($path, $object, $location, $key);
    if (!is_string($value)) {
        dbspec_vector_fail($path, "$location.$key", 'is not a string');
    }
    return $value;
}

/** $key가 없으면 false를, 있으면 boolean인지 확인한 값을 돌려준다. */
function dbspec_vector_flag(string $path, stdClass $object, string $location, string $key): bool
{
    if (!property_exists($object, $key)) {
        return false;
    }
    $value = $object->$key;
    if (!is_bool($value)) {
        dbspec_vector_fail($path, "$location.$key", 'is not a boolean');
    }
    return $value;
}

/** @return list<string> */
function dbspec_vector_check_lines(string $path, mixed $value, string $at): array
{
    if (!is_array($value)) {
        dbspec_vector_fail($path, $at, 'is not an array');
    }
    foreach ($value as $i => $line) {
        if (!is_string($line)) {
            dbspec_vector_fail($path, "{$at}[$i]", 'is not a string');
        }
    }
    return $value;
}

/** @return list<string> */
function dbspec_vector_lines(string $path, stdClass $object, string $location, string $key): array
{
    return dbspec_vector_check_lines($path, dbspec_vector_field($path, $object, $location, $key), "$location.$key");
}

/** 이름마다 line array를 가진 object를 확인한다. @return array<string, list<string>> */
function dbspec_vector_documents(string $path, stdClass $object, string $location, string $key): array
{
    $value = dbspec_vector_field($path, $object, $location, $key);
    if (!$value instanceof stdClass) {
        dbspec_vector_fail($path, "$location.$key", 'is not an object');
    }
    $documents = [];
    foreach (get_object_vars($value) as $name => $lines) {
        $documents[$name] = dbspec_vector_check_lines($path, $lines, "$location.$key.$name");
    }
    return $documents;
}

/**
 * section $key의 각 case가 object인지와 그 id를 확인하고, $read가 돌려준 field에 id를 더한 list를 돌려준다.
 *
 * @return list<array<string, mixed>>
 */
function dbspec_vector_cases(string $path, stdClass $object, string $key, callable $read): array
{
    $section = dbspec_vector_field($path, $object, '', $key);
    if (!is_array($section)) {
        dbspec_vector_fail($path, $key, 'is not an array');
    }
    $cases = [];
    foreach ($section as $i => $case) {
        $at = "{$key}[$i]";
        if (!$case instanceof stdClass) {
            dbspec_vector_fail($path, $at, 'is not an object');
        }
        $cases[] = ['id' => dbspec_vector_string($path, $case, $at, 'id')] + $read($case, $at);
    }
    return $cases;
}

/**
  * 줄을 LF로, $crlf이면 CRLF로, $mixed이면 CRLF와 LF를 번갈아 마지막 줄 끝 없이 잇는다.
 *
 * @param list<string> $lines
 */
function dbspec_join(array $lines, bool $crlf, bool $mixed): string
{
    $text = '';
    $last = count($lines) - 1;
    foreach ($lines as $i => $line) {
        $text .= $line;
        if ($mixed) {
            $text .= $i === $last ? '' : ($i % 2 === 0 ? "\r\n" : "\n");
        } else {
            $text .= $crlf ? "\r\n" : "\n";
        }
    }
    return $text;
}

/** $text의 diagnostic을, 없으면 그 emission을 출력한다. @param array<string, string> $set */
function dbspec_write(string $text, array $set, bool $stress): void
{
    $result = Orm\Dbspec\Dbspec::parse($text, $set);
    if ($result->diagnostics !== []) {
        foreach ($result->diagnostics as $d) {
            echo "! {$d->rule} {$d->line} {$d->column}\n";
        }
        return;
    }
    $emitted = Orm\Dbspec\Dbspec::emit($result->document);
    if ($stress) {
        echo $emitted === $text ? "= unchanged\n" : "= changed\n";
        return;
    }
    foreach (explode("\n", $emitted) as $line) {
        echo "| $line\n";
    }
}

$cases = dbspec_read_vectors($argv[1], static function (string $path, stdClass $v): array {
    $cases = [];
    foreach (['canonical', 'normalize', 'invalid'] as $kind) {
        $cases[$kind] = dbspec_vector_cases($path, $v, $kind, static function (stdClass $case, string $at) use ($path): array {
            $main = dbspec_vector_string($path, $case, $at, 'main');
            $documents = dbspec_vector_documents($path, $case, $at, 'documents');
            if (!array_key_exists($main, $documents)) {
                dbspec_vector_fail($path, "$at.documents.$main", 'is missing');
            }
            return [
                'main' => $main,
                'documents' => $documents,
                'crlf' => dbspec_vector_flag($path, $case, $at, 'crlf'),
                'mixed' => dbspec_vector_flag($path, $case, $at, 'mixed'),
            ];
        });
    }
    $cases['hashes'] = dbspec_vector_cases($path, $v, 'hashes', static fn(stdClass $case, string $at): array => [
        'documents' => dbspec_vector_documents($path, $case, $at, 'documents'),
    ]);
    return $cases;
});
$stress = dbspec_read_input($argv[2]);
foreach (['canonical', 'normalize', 'invalid'] as $kind) {
    foreach ($cases[$kind] as $case) {
        $crlf = $case['crlf'];
        $mixed = $case['mixed'];
        $set = [];
        foreach ($case['documents'] as $name => $lines) {
            if ($name !== $case['main']) {
                $set[$name] = dbspec_join($lines, $crlf, $mixed);
            }
        }
        echo "$kind/{$case['id']}\n";
        dbspec_write(dbspec_join($case['documents'][$case['main']], $crlf, $mixed), $set, false);
    }
}
echo "stress\n";
dbspec_write($stress, [], true);

/** diagnostic을 출력한다. @param list<Orm\Dbspec\Diagnostic> $diagnostics */
function dbspec_diagnostics(array $diagnostics): void
{
    foreach ($diagnostics as $d) {
        echo "! {$d->rule} {$d->line} {$d->column}\n";
    }
}

/** case 문서 집합의 hash와 text를, 또는 문서나 집합의 diagnostic을 출력한다. */
function dbspec_write_manifest(array $case): void
{
    $names = array_keys($case['documents']);
    sort($names, SORT_STRING);
    $documents = [];
    foreach ($names as $name) {
        $set = [];
        foreach ($case['documents'] as $other => $lines) {
            if ($other !== $name) {
                $set[$other] = dbspec_join($lines, false, false);
            }
        }
        $result = Orm\Dbspec\Dbspec::parse(dbspec_join($case['documents'][$name], false, false), $set);
        if ($result->document === null) {
            dbspec_diagnostics($result->diagnostics);
            return;
        }
        $documents[] = $result->document;
    }
    $result = Orm\Dbspec\Dbspec::manifest($documents);
    if ($result->manifest === null) {
        dbspec_diagnostics($result->diagnostics);
        return;
    }
    $m = $result->manifest;
    echo "= manifestHash {$m->manifestHash}\n= schemaHash {$m->schemaHash}\n= manifestText\n";
    foreach (explode("\n", $m->manifestText) as $line) {
        echo "| $line\n";
    }
    echo "= schemaText\n";
    foreach (explode("\n", $m->schemaText) as $line) {
        echo "| $line\n";
    }
}

foreach ($cases['hashes'] as $case) {
    echo "hashes/{$case['id']}\n";
    dbspec_write_manifest($case);
}

/** case 문서 집합의 statement를 dialect마다, 또는 문서나 집합의 diagnostic을 출력한다. */
function dbspec_write_render(array $case): void
{
    $names = array_keys($case['documents']);
    sort($names, SORT_STRING);
    $documents = [];
    foreach ($names as $name) {
        $set = [];
        foreach ($case['documents'] as $other => $lines) {
            if ($other !== $name) {
                $set[$other] = dbspec_join($lines, false, false);
            }
        }
        $result = Orm\Dbspec\Dbspec::parse(dbspec_join($case['documents'][$name], false, false), $set);
        if ($result->document === null) {
            echo "render/{$case['id']}\n";
            dbspec_diagnostics($result->diagnostics);
            return;
        }
        $documents[] = $result->document;
    }
    foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
        echo "render/{$case['id']}/$dialect\n";
        $result = Orm\Dbspec\Dbspec::render($documents, $dialect);
        dbspec_diagnostics($result->diagnostics);
        foreach ($result->statements ?? [] as $statement) {
            echo "| $statement\n";
        }
    }
}

/** step 하나를 statement 줄과 그 속성 줄로 쓴다(tests/dbspec/compare/check.mjs). */
function dbspec_step(Orm\Dbspec\PlanStep $s): void
{
    echo "| {$s->statement}\n";
    if ($s->finalize) {
        echo "  finalize\n";
    } elseif ($s->rollback !== '') {
        echo "  rollback: {$s->rollback}\n";
    } else {
        echo "  irreversible: {$s->irreversible}\n";
    }
    echo '  effect: ' . $s->effect->text() . "\n";
    if ($s->restore !== '') {
        echo "  restore: {$s->restore}\n";
    }
    if ($s->rollbackRestore !== '') {
        echo "  rollback_restore: {$s->rollbackRestore}\n";
    }
    if ($s->restore !== '' || $s->rollbackRestore !== '') {
        echo '  restore_if: ' . $s->restoreIf?->text() . "\n";
    }
    foreach ($s->nullChecks as $c) {
        echo "  null_check: {$c->table} {$c->column} " . ($c->default ?? 'none') . "\n";
    }
}

$ddl = dbspec_read_vectors($argv[3], static fn(string $path, stdClass $v): array => dbspec_vector_cases(
    $path,
    $v,
    'cases',
    static fn(stdClass $case, string $at): array => ['documents' => dbspec_vector_documents($path, $case, $at, 'documents')],
));
foreach ($ddl as $case) {
    dbspec_write_render($case);
}

/**
  * diagnostic을 출력한다. plan, chain, compare diagnostic은 모든 client가 공유하는
  * message로 끝나고, target이나 source의 schema diagnostic은 그렇지 않다.
 *
 * @param list<Orm\Dbspec\Diagnostic> $diagnostics
 */
function dbspec_plan_diagnostics(array $diagnostics): void
{
    foreach ($diagnostics as $d) {
        echo in_array($d->rule, ['plan', 'chain', 'compare'], true) ? "! {$d->rule} {$d->line} {$d->column} {$d->message}\n" : "! {$d->rule} {$d->line} {$d->column}\n";
    }
}

/**
  * plan case의 source schema이고, 빈 schema이면 null, diagnostic을 출력했으면 false다.
 *
 * @param ?list<string> $lines
 */
function dbspec_plan_source(?array $lines): Orm\Dbspec\Document|null|false
{
    if ($lines === null) {
        return null;
    }
    $result = Orm\Dbspec\Dbspec::parse(dbspec_join($lines, false, false), []);
    if ($result->document === null) {
        dbspec_plan_diagnostics($result->diagnostics);
        return false;
    }
    return $result->document;
}

/** change를 "| kind table name"으로 출력한다. @param list<Orm\Dbspec\Change> $changes */
function dbspec_changes(array $changes): void
{
    foreach ($changes as $c) {
        echo "| {$c->kind} {$c->table} {$c->name}\n";
    }
}

/** emit한 plan의 줄을 출력한다. */
function dbspec_emitted_plan(Orm\Dbspec\Plan $plan): void
{
    foreach (explode("\n", Orm\Dbspec\Dbspec::emitPlan($plan)) as $line) {
        echo "| $line\n";
    }
}

$plans = dbspec_read_vectors($argv[4], static function (string $path, stdClass $v): array {
    $plans = [];
    foreach (['cases', 'invalid'] as $kind) {
        $plans[$kind] = dbspec_vector_cases($path, $v, $kind, static function (stdClass $case, string $at) use ($path): array {
            $source = dbspec_vector_field($path, $case, $at, 'source');
            return [
                'source' => $source === null ? null : dbspec_vector_check_lines($path, $source, "$at.source"),
                'plan' => dbspec_vector_lines($path, $case, $at, 'plan'),
            ];
        });
    }
    $plans['chains'] = dbspec_vector_cases($path, $v, 'chains', static function (stdClass $case, string $at) use ($path): array {
        $list = dbspec_vector_field($path, $case, $at, 'plans');
        if (!is_array($list)) {
            dbspec_vector_fail($path, "$at.plans", 'is not an array');
        }
        $chain = [];
        foreach ($list as $i => $lines) {
            $chain[] = dbspec_vector_check_lines($path, $lines, "$at.plans[$i]");
        }
        return ['plans' => $chain];
    });
    $plans['parse'] = dbspec_vector_cases($path, $v, 'parse', static fn(stdClass $case, string $at): array => [
        'plan' => dbspec_vector_lines($path, $case, $at, 'plan'),
    ]);
    $plans['comparisons'] = dbspec_vector_cases($path, $v, 'comparisons', static fn(stdClass $case, string $at): array => [
        'source' => dbspec_vector_lines($path, $case, $at, 'source'),
        'target' => dbspec_vector_lines($path, $case, $at, 'target'),
    ]);
    return $plans;
});
foreach ($plans['cases'] as $case) {
    echo "plans/cases/{$case['id']}\n";
    $source = dbspec_plan_source($case['source']);
    if ($source === false) {
        continue;
    }
    $parsed = Orm\Dbspec\Dbspec::parsePlan(dbspec_join($case['plan'], false, false));
    if ($parsed->plan === null) {
        dbspec_plan_diagnostics($parsed->diagnostics);
        continue;
    }
    dbspec_emitted_plan($parsed->plan);
    echo "plans/cases/{$case['id']}/changes\n";
    $diff = Orm\Dbspec\Dbspec::diff($source, $parsed->plan);
    dbspec_plan_diagnostics($diff->diagnostics);
    dbspec_changes($diff->changes ?? []);
    foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
        echo "plans/cases/{$case['id']}/$dialect\n";
        $result = Orm\Dbspec\Dbspec::planSteps($source, $parsed->plan, $dialect);
        dbspec_plan_diagnostics($result->diagnostics);
        foreach ($result->steps ?? [] as $step) {
            dbspec_step($step);
        }
    }
}
foreach ($plans['invalid'] as $case) {
    echo "plans/invalid/{$case['id']}\n";
    $source = dbspec_plan_source($case['source']);
    if ($source === false) {
        continue;
    }
    $parsed = Orm\Dbspec\Dbspec::parsePlan(dbspec_join($case['plan'], false, false));
    if ($parsed->plan === null) {
        dbspec_plan_diagnostics($parsed->diagnostics);
        continue;
    }
    $diff = Orm\Dbspec\Dbspec::diff($source, $parsed->plan);
    dbspec_plan_diagnostics($diff->diagnostics);
    dbspec_changes($diff->changes ?? []);
}
foreach ($plans['chains'] as $case) {
    echo "plans/chains/{$case['id']}\n";
    $parsedPlans = [];
    foreach ($case['plans'] as $lines) {
        $parsed = Orm\Dbspec\Dbspec::parsePlan(dbspec_join($lines, false, false));
        dbspec_plan_diagnostics($parsed->diagnostics);
        $parsedPlans[] = $parsed->plan;
    }
    if (in_array(null, $parsedPlans, true)) {
        continue;
    }
    $chain = Orm\Dbspec\Dbspec::chain($parsedPlans);
    dbspec_plan_diagnostics($chain->diagnostics);
    foreach ($chain->plans ?? [] as $plan) {
        echo "| {$plan->name}\n";
    }
}
foreach ($plans['parse'] as $case) {
    echo "plans/parse/{$case['id']}\n";
    $parsed = Orm\Dbspec\Dbspec::parsePlan(dbspec_join($case['plan'], false, false));
    if ($parsed->plan === null) {
        dbspec_plan_diagnostics($parsed->diagnostics);
        continue;
    }
    dbspec_emitted_plan($parsed->plan);
}
foreach ($plans['comparisons'] as $case) {
    echo "plans/comparisons/{$case['id']}\n";
    $source = Orm\Dbspec\Dbspec::parse(dbspec_join($case['source'], false, false), []);
    dbspec_plan_diagnostics($source->diagnostics);
    $target = Orm\Dbspec\Dbspec::parse(dbspec_join($case['target'], false, false), []);
    dbspec_plan_diagnostics($target->diagnostics);
    if ($source->document === null || $target->document === null) {
        continue;
    }
    $result = Orm\Dbspec\Dbspec::compareSchemas($source->document, $target->document);
    dbspec_plan_diagnostics($result->diagnostics);
    foreach ($result->differences ?? [] as $d) {
        echo "| {$d->kind} {$d->table} {$d->name}\n";
    }
}

/** export나 import가 뺀 것을 "= kind<TAB>table<TAB>name"으로 출력하며 이유는 비교하지 않는다. @param list<Orm\Dbspec\Unsupported> $dropped */
function dbspec_dropped(array $dropped): void
{
    foreach ($dropped as $u) {
        echo "= {$u->kind}\t{$u->table}\t{$u->name}\n";
    }
}

/** 문서의 Mermaid text와 빠진 객체를 출력하고 text를 돌려준다. */
function dbspec_export(Orm\Dbspec\Document $document): string
{
    $result = Orm\Dbspec\Dbspec::exportMermaid($document);
    foreach (explode("\n", $result->text) as $line) {
        echo "| $line\n";
    }
    dbspec_dropped($result->dropped);
    return $result->text;
}

/** import의 emit한 문서와 빠진 객체를, 또는 diagnostic을 출력한다. */
function dbspec_import(string $text): void
{
    $result = Orm\Dbspec\Dbspec::importMermaid($text, 'imported');
    if ($result->document === null) {
        dbspec_plan_diagnostics($result->diagnostics);
        return;
    }
    foreach (explode("\n", Orm\Dbspec\Dbspec::emit($result->document)) as $line) {
        echo "| $line\n";
    }
    dbspec_dropped($result->dropped);
}

$mermaid = dbspec_read_vectors($argv[5], static function (string $path, stdClass $v): array {
    $mermaid = [];
    $mermaid['export'] = dbspec_vector_cases($path, $v, 'export', static fn(stdClass $case, string $at): array => [
        'document' => dbspec_vector_lines($path, $case, $at, 'document'),
        'documents' => dbspec_vector_documents($path, $case, $at, 'documents'),
    ]);
    foreach (['import', 'invalid'] as $kind) {
        $mermaid[$kind] = dbspec_vector_cases($path, $v, $kind, static fn(stdClass $case, string $at): array => [
            'mermaid' => dbspec_vector_lines($path, $case, $at, 'mermaid'),
        ]);
    }
    $mermaid['round_trip'] = dbspec_vector_cases($path, $v, 'round_trip', static fn(stdClass $case, string $at): array => [
        'path' => dbspec_vector_string($path, $case, $at, 'path'),
    ]);
    return $mermaid;
});
foreach ($mermaid['export'] as $case) {
    echo "mermaid/export/{$case['id']}\n";
    $set = array_map(static fn(array $lines): string => dbspec_join($lines, false, false), $case['documents']);
    $parsed = Orm\Dbspec\Dbspec::parse(dbspec_join($case['document'], false, false), $set);
    if ($parsed->document === null) {
        dbspec_plan_diagnostics($parsed->diagnostics);
        continue;
    }
    dbspec_export($parsed->document);
}
foreach (['import', 'invalid'] as $kind) {
    foreach ($mermaid[$kind] as $case) {
        echo "mermaid/$kind/{$case['id']}\n";
        dbspec_import(dbspec_join($case['mermaid'], false, false));
    }
}
foreach ($mermaid['round_trip'] as $case) {
    echo "mermaid/round_trip/{$case['id']}\n";
    $source = dbspec_read_input($case['path']);
    $parsed = Orm\Dbspec\Dbspec::parse($source, []);
    if ($parsed->document === null) {
        dbspec_plan_diagnostics($parsed->diagnostics);
        continue;
    }
    $text = dbspec_export($parsed->document);
    echo "mermaid/round_trip/{$case['id']}/import\n";
    dbspec_import($text);
}
