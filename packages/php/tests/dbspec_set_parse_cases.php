<?php

declare(strict_types=1);

use PHPUnit\Framework\Assert;

// The shared vectors tests/dbspec/set-parse.json of the set parse (docs/spec/dbspec.md "Parsing a set"), run against a
// parseSet of the PHP client or of the extension. Each case is one data set; $check, when given, sees every result too.

/**
 * The result of a set parse as plain data: each document's name, external mark, document (as JSON of its public
 * state), positions and diagnostics.
 *
 * @param list<object> $result
 * @return list<array<string, mixed>>
 */
function dbspec_set_parse_described(array $result): array
{
    $diagnostic = static fn(object $d): array => [$d->rule, $d->line, $d->column, $d->message];
    return array_map(static fn(object $d): array => [
            'name' => $d->name,
            'external' => $d->external,
            'document' => $d->document === null ? null : json_encode($d->document, JSON_UNESCAPED_SLASHES),
            'positions' => $d->positions === null ? null : json_encode($d->positions, JSON_UNESCAPED_SLASHES),
            'diagnostics' => array_map($diagnostic, $d->diagnostics),
        ], $result);
}

/**
 * The data sets of tests/dbspec/set-parse.json, each named by its case id and holding [case]. A repeated id is an
 * error.
 *
 * @return iterable<string, array{array<string, mixed>}>
 */
function dbspec_set_parse_sets(string $root): iterable
{
    $vectors = json_decode(file_get_contents("$root/tests/dbspec/set-parse.json"), true, 512, JSON_THROW_ON_ERROR);
    $seen = [];
    foreach ($vectors['cases'] as $case) {
        if (isset($seen[$case['id']])) {
            throw new RuntimeException("repeated set parse case {$case['id']}");
        }
        $seen[$case['id']] = true;
        yield $case['id'] => [$case];
    }
}

/**
 * Runs one vector through $parse(owned, external) with the PHPUnit assertions; $check, when given, sees the result too.
 */
function dbspec_set_parse_check(array $case, callable $parse, ?callable $check = null): void
{
    $result = $parse($case['owned'], $case['external']);
    // A vector diagnostic states its rule and place, and its message where the rule fixes one.
    $want = $case['documents'];
    $got = array_map(static fn(object $d, int $i): array => [
        'name' => $d->name,
        'external' => $d->external,
        'parsed' => $d->document !== null,
        'diagnostics' => array_map(
            static fn(object $x, int $k): array => array_intersect_key(
                ['rule' => $x->rule, 'line' => $x->line, 'column' => $x->column, 'message' => $x->message],
                $want[$i]['diagnostics'][$k] ?? ['rule' => 0, 'line' => 0, 'column' => 0]
            ),
            $d->diagnostics,
            array_keys($d->diagnostics)
        ),
    ], $result, array_keys($result));
    Assert::assertEquals($want, $got);
    foreach ($result as $d) {
        if ($d->document !== null) {
            Assert::assertSame(
                $d->external,
                $d->document->external,
                "document {$d->name} is not marked as its text is"
            );
        }
    }
    if ($check !== null) {
        $check($result, $case);
    }
}
