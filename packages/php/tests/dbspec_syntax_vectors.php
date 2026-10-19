<?php
declare(strict_types=1);

// The shared syntax vectors (tests/dbspec/syntax.json, docs/spec/dbspec.md "Syntax analysis"): a strict reader, and the
// analyses the vectors need, built as scripts/dbspec/syntax-vectors.mts builds them (vectorInputs). Shared by the PHP
// client test and the extension test; every runtime matches the same tokens exactly.

const DBSPEC_SYNTAX_CLASSES = [
    'keyword' => true, 'type' => true, 'name' => true, 'setting' => true, 'number' => true, 'string' => true,
    'operator' => true, 'punctuation' => true, 'comment' => true, 'word' => true,
];

/** Throws unless the object has exactly these keys: a missing or an unknown field is an error. */
function dbspec_syntax_exact_keys(mixed $object, string $location, array $keys): void
{
    if (!is_array($object) || array_is_list($object) && $object !== []) {
        throw new RuntimeException("$location is not an object");
    }
    foreach ($keys as $key) {
        if (!array_key_exists($key, $object)) {
            throw new RuntimeException("$location.$key is missing");
        }
    }
    foreach (array_keys($object) as $key) {
        if (!in_array($key, $keys, true)) {
            throw new RuntimeException("$location.$key is not a known field");
        }
    }
}

/**
 * Reads tests/dbspec/syntax.json strictly: the version, the exact fields, every case with its exact fields and its
 * tokens, each token four integers and a known class, and no case id twice.
 *
 * @return array<string, list<array{0:int,1:int,2:int,3:string}>>
 */
function dbspec_syntax_load(string $root): array
{
    $object = json_decode((string) file_get_contents("$root/tests/dbspec/syntax.json"), true, 512, JSON_THROW_ON_ERROR);
    dbspec_syntax_exact_keys($object, 'syntax.json', ['version', 'note', 'cases']);
    if ($object['version'] !== 1) {
        throw new RuntimeException('syntax.json has an unknown version');
    }
    if (!is_string($object['note'])) {
        throw new RuntimeException('syntax.json.note is not a string');
    }
    if (!is_array($object['cases']) || !array_is_list($object['cases'])) {
        throw new RuntimeException('syntax.json.cases is not a list');
    }
    $out = [];
    foreach ($object['cases'] as $i => $case) {
        $at = "syntax.json.cases[$i]";
        dbspec_syntax_exact_keys($case, $at, ['id', 'tokens']);
        if (!is_string($case['id']) || !is_array($case['tokens']) || !array_is_list($case['tokens'])) {
            throw new RuntimeException("$at has a bad id or tokens");
        }
        if (isset($out[$case['id']])) {
            throw new RuntimeException("syntax.json repeats the case id {$case['id']}");
        }
        $tokens = [];
        foreach ($case['tokens'] as $j => $token) {
            $where = "$at.tokens[$j]";
            if (!is_array($token) || !array_is_list($token) || count($token) !== 4) {
                throw new RuntimeException("$where does not have four items");
            }
            foreach ([0, 1, 2] as $k) {
                if (!is_int($token[$k])) {
                    throw new RuntimeException("$where[$k] is not an integer");
                }
            }
            if (!is_string($token[3]) || !isset(DBSPEC_SYNTAX_CLASSES[$token[3]])) {
                throw new RuntimeException("$where[3] is not a token class");
            }
            $tokens[] = [$token[0], $token[1], $token[2], $token[3]];
        }
        $out[$case['id']] = $tokens;
    }
    return $out;
}

/** join as scripts/dbspec/syntax-vectors.mts writes a document: LF, CRLF, or alternating CRLF and LF with no final end. */
function dbspec_syntax_join(array $lines, bool $crlf, bool $mixed = false): string
{
    if ($mixed) {
        $text = '';
        $last = count($lines) - 1;
        foreach (array_values($lines) as $i => $line) {
            $text .= $line;
            if ($i < $last) {
                $text .= $i % 2 === 0 ? "\r\n" : "\n";
            }
        }
        return $text;
    }
    $end = $crlf ? "\r\n" : "\n";
    return implode($end, $lines) . $end;
}

/**
 * The analyses the vectors need, in the order of the generator: the canonical, normalize and invalid cases, then the
 * sets documents and the hashes documents. Each is [id, text, documents], the documents being the other documents.
 *
 * @return list<array{0:string,1:string,2:array<string,string>}>
 */
function dbspec_syntax_inputs(array $cases): array
{
    $inputs = [];
    foreach (['canonical', 'normalize', 'invalid'] as $section) {
        foreach ($cases[$section] as $c) {
            if (!isset($c['documents'][$c['main']])) {
                throw new RuntimeException("$section/{$c['id']}: the main document {$c['main']} is missing");
            }
            $crlf = ($c['crlf'] ?? false) === true;
            $mixed = ($c['mixed'] ?? false) === true;
            $documents = [];
            foreach ($c['documents'] as $name => $lines) {
                if ($name !== $c['main']) {
                    $documents[$name] = dbspec_syntax_join($lines, $crlf, $mixed);
                }
            }
            $inputs[] = ["$section.{$c['id']}", dbspec_syntax_join($c['documents'][$c['main']], $crlf, $mixed), $documents];
        }
    }
    foreach ($cases['sets'] as $c) {
        foreach ($c['documents'] as $i => $lines) {
            $documents = [];
            foreach ($c['parsing'] as $name => $other) {
                $documents[$name] = dbspec_syntax_join($other, false);
            }
            foreach ($c['documents'] as $j => $other) {
                if ($j !== $i) {
                    $words = explode(' ', $other[0]);
                    if (!isset($words[2])) {
                        throw new RuntimeException("sets/{$c['id']}: a document has no name in its first line");
                    }
                    $documents[$words[2]] = dbspec_syntax_join($other, false);
                }
            }
            $inputs[] = ["sets.{$c['id']}." . ($i + 1), dbspec_syntax_join($lines, false), $documents];
        }
    }
    foreach ($cases['hashes'] as $c) {
        foreach (array_keys($c['documents']) as $name) {
            $documents = [];
            foreach ($c['documents'] as $other => $lines) {
                if ($other !== $name) {
                    $documents[$other] = dbspec_syntax_join($lines, false);
                }
            }
            $inputs[] = ["hashes.{$c['id']}.$name", dbspec_syntax_join($c['documents'][$name], false), $documents];
        }
    }
    return $inputs;
}

/**
 * The syntax vector data sets, each named "syntax/<id>" and holding [want, text, documents]: want is the tokens of
 * syntax.json for the input as [line, start, end, class] lists, or null when syntax.json has none (the test fails it).
 * A repeated input id is an error.
 *
 * @return iterable<string, array{?list<array{0:int,1:int,2:int,3:string}>, string, array<string,string>}>
 */
function dbspec_syntax_sets(string $root, array $cases): iterable
{
    $want = dbspec_syntax_load($root);
    $seen = [];
    foreach (dbspec_syntax_inputs($cases) as [$id, $text, $documents]) {
        if (isset($seen[$id])) {
            throw new RuntimeException("$id: the inputs repeat this case");
        }
        $seen[$id] = true;
        yield $id => [$want[$id] ?? null, $text, $documents];
    }
}

/**
 * The cases of syntax.json that the inputs do not produce: syntax.json and the inputs must hold the same set of cases.
 *
 * @return list<string>
 */
function dbspec_syntax_unproduced(string $root, array $cases): array
{
    $produced = [];
    foreach (dbspec_syntax_inputs($cases) as [$id]) {
        $produced[$id] = true;
    }
    return array_values(array_filter(array_keys(dbspec_syntax_load($root)), static fn(string $id): bool => !isset($produced[$id])));
}
