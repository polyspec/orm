<?php

declare(strict_types=1);

// Reads tests/dbspec/cases.json strictly, as the Go reader does (engine/dbspec/vectors_test.go decodeCaseVectors):
// every section and every field of the format must be present with its type, and a section or field the format does
// not name is refused. A refusal is a RuntimeException with the message "<file>: <location> <problem>".

/**
 * A field type is a scalar name, [type] for an array of type, or an object schema whose keys are the fields; a key
 * ending in "?" is an optional field.
 *
 * @return array<string, mixed>
 */
function dbspec_cases_schema(): array
{
    $error = ['line' => 'integer', 'column' => 'integer', 'rule' => 'string'];
    $document = ['id' => 'string', 'documents' => 'linesMap', 'main' => 'string', 'crlf?' => 'boolean', 'mixed?' => 'boolean'];
    return [
        'version' => 'integer',
        'note' => 'string',
        'canonical' => [$document],
        'normalize' => [$document + ['canonical' => 'lines']],
        'invalid' => [$document + ['errors' => [$error]]],
        'hashes' => [['id' => 'string', 'documents' => 'linesMap', 'manifestText' => 'lines', 'schemaText' => 'lines', 'manifestHash' => 'string', 'schemaHash' => 'string']],
        'sets' => [[
            'id' => 'string', 'documents' => ['lines'], 'parsing' => 'linesMap', 'errors' => [$error], 'external?' => ['lines'],
            'manifest?' => ['manifestText' => 'lines', 'externalText' => 'lines', 'schemaText' => 'lines', 'created' => 'lines', 'manifestHash' => 'string', 'schemaHash' => 'string'],
        ]],
        'files' => [['id' => 'string', 'path' => 'string', 'errors' => [$error]]],
        'positions' => [['id' => 'string', 'documents' => 'linesMap', 'main' => 'string', 'positions' => [['kind' => 'string', 'path' => 'lines', 'line' => 'integer', 'column' => 'integer']]]],
    ];
}

function dbspec_cases_refuse(string $name, string $location, string $problem): never
{
    throw new RuntimeException("$name: " . ($location === '' ? '$' : $location) . " $problem");
}

function dbspec_cases_at(string $location, string $key): string
{
    return $location === '' ? $key : "$location.$key";
}

/** Checks $value against $type; a JSON object is decoded as stdClass and an array as a list. */
function dbspec_cases_check(string $name, mixed $value, mixed $type, string $location): void
{
    if ($type === 'string' || $type === 'boolean' || $type === 'integer') {
        $ok = match ($type) {
            'string' => is_string($value),
            'boolean' => is_bool($value),
            'integer' => is_int($value),
        };
        if (!$ok) {
            dbspec_cases_refuse($name, $location, $type === 'integer' ? 'is not an integer' : "is not a $type");
        }
    } elseif ($type === 'lines') {
        dbspec_cases_check($name, $value, ['string'], $location);
    } elseif ($type === 'linesMap') {
        if (!$value instanceof stdClass) {
            dbspec_cases_refuse($name, $location, 'is not an object');
        }
        foreach (get_object_vars($value) as $key => $lines) {
            dbspec_cases_check($name, $lines, 'lines', dbspec_cases_at($location, (string) $key));
        }
    } elseif (array_is_list($type)) {
        if (!is_array($value)) {
            dbspec_cases_refuse($name, $location, 'is not an array');
        }
        foreach ($value as $i => $item) {
            dbspec_cases_check($name, $item, $type[0], "{$location}[$i]");
        }
    } else {
        if (!$value instanceof stdClass) {
            dbspec_cases_refuse($name, $location, 'is not an object');
        }
        $fields = [];
        foreach ($type as $key => $fieldType) {
            $optional = str_ends_with($key, '?');
            $fields[$optional ? substr($key, 0, -1) : $key] = [$fieldType, $optional];
        }
        foreach ($fields as $key => [, $optional]) {
            if (!$optional && !property_exists($value, (string) $key)) {
                dbspec_cases_refuse($name, dbspec_cases_at($location, (string) $key), 'is missing');
            }
        }
        $keys = array_map('strval', array_keys(get_object_vars($value)));
        sort($keys, SORT_STRING);
        foreach ($keys as $key) {
            if (!array_key_exists($key, $fields)) {
                dbspec_cases_refuse($name, dbspec_cases_at($location, $key), 'is not a known field');
            }
        }
        foreach ($fields as $key => [$fieldType]) {
            if (property_exists($value, (string) $key)) {
                dbspec_cases_check($name, $value->$key, $fieldType, dbspec_cases_at($location, (string) $key));
            }
        }
        if (array_key_exists('main', $fields) && !property_exists($value->documents, $value->main)) {
            dbspec_cases_refuse($name, dbspec_cases_at(dbspec_cases_at($location, 'documents'), $value->main), 'is missing');
        }
    }
}

/** Checks $value, cases.json decoded with objects as stdClass; $name names the file in the errors. */
function dbspec_check_cases(stdClass $value, string $name = 'tests/dbspec/cases.json'): void
{
    $schema = dbspec_cases_schema();
    dbspec_cases_check($name, $value, $schema, '');
    if ($value->version !== 1) {
        dbspec_cases_refuse($name, 'version', 'is not 1');
    }
    foreach ($schema as $key => $type) {
        if (is_array($type) && $value->$key === []) {
            dbspec_cases_refuse($name, $key, 'is empty');
        }
    }
}

/**
 * Reads tests/dbspec/cases.json of the repository strictly and returns it with objects as associative arrays.
 *
 * @return array<string, mixed>
 */
function dbspec_read_cases(): array
{
    $text = (string) file_get_contents(__DIR__ . '/cases.json');
    dbspec_check_cases(json_decode($text, false, 512, JSON_THROW_ON_ERROR));
    return json_decode($text, true, 512, JSON_THROW_ON_ERROR);
}
