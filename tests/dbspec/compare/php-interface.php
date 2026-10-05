<?php

declare(strict_types=1);

// dbspec compare runner(php.php, php-extension.php)가 함께 쓰는 vector 읽기와 dbspec 인터페이스 출력이다.
// dbspec_write_interface는 Dbspec class 하나(Orm\Dbspec\Dbspec 또는 확장의 Orm\Dbspec\Native\Dbspec)로
// 공유 case, stress 문서, 파일 읽기, manifest와 statement vector의 결과를 tests/dbspec/compare/check.mjs의
// 줄 형식으로 출력한다. 두 class는 같은 메서드와 결과 모양을 가진다.

require_once __DIR__ . '/../input.php';

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

/** $dbspec으로 parse한 $text의 diagnostic을, 없으면 그 emission을 출력한다. @param array<string, string> $set */
function dbspec_write(string $dbspec, string $text, array $set, bool $stress): void
{
    $result = $dbspec::parse($text, $set);
    if ($result->diagnostics !== []) {
        foreach ($result->diagnostics as $d) {
            echo "! {$d->rule} {$d->line} {$d->column}\n";
        }
        return;
    }
    $emitted = $dbspec::emit($result->document);
    if ($stress) {
        echo $emitted === $text ? "= unchanged\n" : "= changed\n";
        return;
    }
    foreach (explode("\n", $emitted) as $line) {
        echo "| $line\n";
    }
}

/**
 * $path의 dbspec document 파일을 $dbspec::readFile로 읽는다. 읽을 수 없는 파일은 그 이유를,
 * signature가 없는 파일은 그 diagnostic message를 stderr에 쓰고 1로 끝난다.
 */
function dbspec_read_document(string $dbspec, string $path): string
{
    try {
        $read = $dbspec::readFile($path);
    } catch (RuntimeException $e) {
        fwrite(STDERR, $e->getMessage() . "\n");
        exit(1);
    }
    if ($read->text === null) {
        fwrite(STDERR, $read->diagnostics[0]->message . "\n");
        exit(1);
    }
    return $read->text;
}

/** diagnostic을 출력한다. @param list<object> $diagnostics */
function dbspec_diagnostics(array $diagnostics): void
{
    foreach ($diagnostics as $d) {
        echo "! {$d->rule} {$d->line} {$d->column}\n";
    }
}

/** case 문서 집합의 hash와 text를, 또는 문서나 집합의 diagnostic을 출력한다. */
function dbspec_write_manifest(string $dbspec, array $case): void
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
        $result = $dbspec::parse(dbspec_join($case['documents'][$name], false, false), $set);
        if ($result->document === null) {
            dbspec_diagnostics($result->diagnostics);
            return;
        }
        $documents[] = $result->document;
    }
    $result = $dbspec::manifest($documents);
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

/** case 문서 집합의 statement를 dialect마다, 또는 문서나 집합의 diagnostic을 출력한다. */
function dbspec_write_render(string $dbspec, array $case): void
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
        $result = $dbspec::parse(dbspec_join($case['documents'][$name], false, false), $set);
        if ($result->document === null) {
            echo "render/{$case['id']}\n";
            dbspec_diagnostics($result->diagnostics);
            return;
        }
        $documents[] = $result->document;
    }
    foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
        echo "render/{$case['id']}/$dialect\n";
        $result = $dbspec::render($documents, $dialect);
        dbspec_diagnostics($result->diagnostics);
        foreach ($result->statements ?? [] as $statement) {
            echo "| $statement\n";
        }
    }
}

/**
 * $dbspec으로 tests/dbspec/cases.json의 canonical, normalize, invalid case, stress 문서, files case,
 * hashes case와 tests/dbspec/ddl.json의 rendering을 이 순서로 출력한다. vector file은 출력하기 전에
 * 모양을 확인하고, 잘못된 vector는 위치를 밝혀 stderr에 쓰고 1로 끝난다.
 */
function dbspec_write_interface(string $dbspec, string $casesPath, string $stressPath, string $ddlPath): void
{
    $cases = dbspec_read_vectors($casesPath, static function (string $path, stdClass $v): array {
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
        $cases['files'] = dbspec_vector_cases($path, $v, 'files', static fn(stdClass $case, string $at): array => [
            'path' => dbspec_vector_string($path, $case, $at, 'path'),
        ]);
        return $cases;
    });

    $stress = dbspec_read_document($dbspec, $stressPath);
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
            dbspec_write($dbspec, dbspec_join($case['documents'][$case['main']], $crlf, $mixed), $set, false);
        }
    }
    echo "stress\n";
    dbspec_write($dbspec, $stress, [], true);
    // files case는 $dbspec::readFile에 path를 주어 "files/<id>"로, $dbspec::readBytes에 파일
    // byte와 case path를 이름으로 주어 "files/<id>/bytes"로 읽어 diagnostic과 그 message를,
    // 없으면 emission을 출력한다. message 앞의 이름은 "<name>"으로 쓴다.
    foreach ($cases['files'] as $case) {
        $path = dirname($casesPath) . '/' . $case['path'];
        try {
            $reads = [
                "files/{$case['id']}" => [$path, $dbspec::readFile($path)],
                "files/{$case['id']}/bytes" => [$case['path'], $dbspec::readBytes($case['path'], (string) file_get_contents($path))],
            ];
        } catch (RuntimeException $e) {
            fwrite(STDERR, $e->getMessage() . "\n");
            exit(1);
        }
        foreach ($reads as $label => [$name, $read]) {
            echo "$label\n";
            if ($read->text !== null) {
                dbspec_write($dbspec, $read->text, [], false);
                continue;
            }
            foreach ($read->diagnostics as $d) {
                echo "! {$d->rule} {$d->line} {$d->column}\n";
                echo '= ' . (str_starts_with($d->message, $name) ? '<name>' . substr($d->message, strlen($name)) : $d->message) . "\n";
            }
        }
    }

    foreach ($cases['hashes'] as $case) {
        echo "hashes/{$case['id']}\n";
        dbspec_write_manifest($dbspec, $case);
    }

    $ddl = dbspec_read_vectors($ddlPath, static fn(string $path, stdClass $v): array => dbspec_vector_cases(
        $path,
        $v,
        'cases',
        static fn(stdClass $case, string $at): array => ['documents' => dbspec_vector_documents($path, $case, $at, 'documents')],
    ));
    foreach ($ddl as $case) {
        dbspec_write_render($dbspec, $case);
    }
}
