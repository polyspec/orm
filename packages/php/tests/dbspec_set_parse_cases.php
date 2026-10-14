<?php
declare(strict_types=1);

// The shared vectors tests/dbspec/set-parse.json of the set parse (docs/dbspec.md "Parsing a set"), run against a
// parseSet of the PHP client or of the extension. Each case is one testcase; $check, when given, sees every result too.

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

/** Runs every vector through $parse(owned, external); returns the number of cases. */
function dbspec_set_parse_run(string $root, string $prefix, callable $parse, ?callable $check = null): int
{
    $vectors = json_decode(file_get_contents("$root/tests/dbspec/set-parse.json"), true, 512, JSON_THROW_ON_ERROR);
    foreach ($vectors['cases'] as $case) {
        $ok = testcase_run("$prefix/{$case['name']}", TESTCASE_COMPUTE, static function () use ($case, $parse, $check): void {
            $result = $parse($case['owned'], $case['external']);
            // A vector diagnostic states its rule and place, and its message where the rule fixes one.
            $want = $case['documents'];
            $got = array_map(static fn(object $d, int $i): array => [
                'name' => $d->name,
                'external' => $d->external,
                'parsed' => $d->document !== null,
                'diagnostics' => array_map(static fn(object $x, int $k): array => array_intersect_key(['rule' => $x->rule, 'line' => $x->line, 'column' => $x->column, 'message' => $x->message], $want[$i]['diagnostics'][$k] ?? ['rule' => 0, 'line' => 0, 'column' => 0]), $d->diagnostics, array_keys($d->diagnostics)),
            ], $result, array_keys($result));
            if ($got != $want) {
                throw new RuntimeException('want ' . json_encode($want) . ', got ' . json_encode($got));
            }
            foreach ($result as $d) {
                if ($d->document !== null && $d->document->external !== $d->external) {
                    throw new RuntimeException("document {$d->name} is not marked as its text is");
                }
            }
            if ($check !== null) {
                $check($result, $case);
            }
        });
        if (!$ok) {
            exit(1);
        }
    }
    return count($vectors['cases']);
}
