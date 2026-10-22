<?php

declare(strict_types=1);

// Reads the shared dbspec vector files against their JSON Schemas (tests/dbspec/schema, draft 2020-12) with
// opis/json-schema, the schemas that the TypeScript runner reads them with (tests/dbspec/vectors.mts). A refused file
// is reported in the form that every compare runner shares (tests/dbspec/compare/runners.test.mts): one
// "<file>: <location> <problem>" line per refusal, where the location is the dotted path of the value
// (`canonical[0].documents.shop`). Every refusal of a file is reported, as the other runners report them.

require_once __DIR__ . '/../../vendor-php/autoload.php';

use Opis\JsonSchema\Errors\ValidationError;
use Opis\JsonSchema\Validator;

/**
 * The dotted path of a value: object keys joined with ".", array indexes in brackets. @param list<int|string> $segments
 */
function dbspec_vector_location(array $segments): string
{
    $path = '';
    foreach ($segments as $segment) {
        $segment = (string) $segment;
        $path = preg_match('/^\d+$/', $segment) === 1 ? "{$path}[$segment]" : (
            $path === '' ? $segment : "$path.$segment"
        );
    }
    return $path;
}

/**
 * The shared form of one refusal: the location of each value it refuses and what is wrong there.
 *
 * @return list<string>
 */
function dbspec_vector_problems(ValidationError $error): array
{
    $at = $error->data()->fullPath();
    $args = $error->args();
    $articles = [
        'integer' => 'an integer',
        'object' => 'an object',
        'array' => 'an array',
        'string' => 'a string',
        'boolean' => 'a boolean',
        'number' => 'a number',
        'null' => 'null'
    ];
    return match ($error->keyword()) {
        'required' => array_map(
            static fn(string $name): string => dbspec_vector_location([...$at, $name]) . ' is missing',
            $args['missing']
        ),
        'additionalProperties', 'unevaluatedProperties' => array_map(
            static fn(string $name): string => dbspec_vector_location([...$at, $name]) . ' is not a known field',
            $args['properties'],
        ),
        'type' => [
            dbspec_vector_location($at) . ' is not ' . implode(
                ' or ',
                array_map(static fn(string $type): string => $articles[$type] ?? $type, (array) $args['expected'])
            )
        ],
        'minItems' => [dbspec_vector_location($at) . ' is empty'],
        'const' => [
            dbspec_vector_location($at) . ' is not ' . json_encode(
                $args['const'],
                JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR
            )
        ],
        default => [
            dbspec_vector_location($at) . " fails the {$error->keyword()} rule of its schema: {$error->message()}"
        ],
    };
}

/**
 * The refusals of an error that hold no nested error: the keywords that refused a value. @return list<ValidationError>
 */
function dbspec_vector_leaves(ValidationError $error): array
{
    $sub = $error->subErrors();
    return $sub === [] ? [$error] : array_merge(...array_map('dbspec_vector_leaves', $sub));
}

/**
 * The refusals of $value, a vector file decoded with objects as stdClass, by the schema
 * tests/dbspec/schema/$kind.schema.json, each "<name>: <location> <problem>"; none when the schema accepts it.
 *
 * @return list<string>
 */
function dbspec_vector_refusals(mixed $value, string $kind, string $name): array
{
    $schema = json_decode(
        (string) file_get_contents(__DIR__ . "/schema/$kind.schema.json"),
        false,
        512,
        JSON_THROW_ON_ERROR
    );
    // The validator collects every refusal instead of stopping at the first (its default).
    $validator = new Validator(max_errors: PHP_INT_MAX, stop_at_first_error: false);
    $error = $validator->validate($value, $schema)->error();
    if ($error === null) {
        return [];
    }
    $lines = [];
    foreach (dbspec_vector_leaves($error) as $leaf) {
        foreach (dbspec_vector_problems($leaf) as $problem) {
            $lines[] = "$name: $problem";
        }
    }
    return $lines;
}

/** Checks $value against the schema $kind; a refusal is a RuntimeException whose message holds one line per problem. */
function dbspec_check_vectors(mixed $value, string $kind, string $name): void
{
    $lines = dbspec_vector_refusals($value, $kind, $name);
    if ($lines !== []) {
        throw new RuntimeException(implode("\n", $lines));
    }
}
