<?php

declare(strict_types=1);

// Reads tests/dbspec/cases.json against its schema (tests/dbspec/schema/cases.schema.json, tests/dbspec/vectors.php):
// every section and every field of the format must be present with its type, a section or field the format does not
// name is refused, and every section has a case. The schema cannot state that the main document of a case is one of
// its documents; dbspec_check_cases checks it. A refusal is a RuntimeException whose message holds one
// "<file>: <location> <problem>" line per problem.

/** Checks $value, cases.json decoded with objects as stdClass; $name names the file in the errors. */
function dbspec_check_cases(stdClass $value, string $name = 'tests/dbspec/cases.json'): void
{
    dbspec_check_vectors($value, 'cases', $name);
    foreach (['canonical', 'normalize', 'invalid', 'positions'] as $section) {
        foreach ($value->$section as $i => $case) {
            if (!property_exists($case->documents, $case->main)) {
                throw new RuntimeException("$name: {$section}[$i].documents.{$case->main} is missing");
            }
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
