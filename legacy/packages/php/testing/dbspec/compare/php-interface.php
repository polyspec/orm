<?php

declare(strict_types=1);

// Reads the vectors and writes the output shared by the dbspec compare runners (php.php, php-extension.php). The output
// functions take a Dbspec class (Polyspec\Orm\Dbspec\Dbspec or the extension's Polyspec\Orm\Dbspec\Native\Dbspec) and
// write in the line format of tests/dbspec/compare/check.mts: dbspec_write_interface writes the recipe cases, stress
// documents, file reads, manifest and statement vectors, dbspec_write_plans writes the plan vectors, and
// dbspec_write_mermaid writes the Mermaid recipe. The two classes have the same methods and result shape.

/** Writes the location and problem of a vector file to stderr and exits with 1. */
function dbspec_vector_fail(string $path, string $location, string $problem): never
{
    fwrite(STDERR, "$path: $location $problem\n");
    exit(1);
}

/** The JSON value of the text $text of $path, with objects as objects; a text that is no JSON is written to stderr and ends with 1. */
function dbspec_decode_input(string $path, string $text): mixed
{
    try {
        return json_decode($text, false, 512, JSON_THROW_ON_ERROR);
    } catch (JsonException $e) {
        fwrite(STDERR, "$path: {$e->getMessage()}\n");
        exit(1);
    }
}

/**
 * Reads the vector file at $path against the schema tests/dbspec/schema/$kind.schema.json (tests/dbspec/vectors.php)
 * and returns it with objects as associative arrays; a refusal is written to stderr, one line per problem, and ends
 * with 1.
 *
 * @return array<string, mixed>
 */
function dbspec_read_vectors(string $path, string $kind): array
{
    $text = dbspec_read_input($path);
    $value = dbspec_decode_input($path, $text);
    try {
        dbspec_check_vectors($value, $kind, $path);
    } catch (RuntimeException $e) {
        fwrite(STDERR, $e->getMessage() . "\n");
        exit(1);
    }
    return json_decode($text, true, 512, JSON_THROW_ON_ERROR);
}

/**
  * Joins the lines with LF, with CRLF if $crlf, or alternating CRLF and LF if $mixed, with no line ending after the
  * last line.
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

/**
 * Writes the diagnostics of $text parsed with $dbspec, or its emission if there are none. @param array<string, string>
 * $set
 */
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
 * Reads the dbspec document file at $path with $dbspec::readFile. A file that cannot be read writes its reason,
 * and a file without a signature writes its diagnostic message to stderr and exits with 1.
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

/** Writes the diagnostics. @param list<object> $diagnostics */
function dbspec_diagnostics(array $diagnostics): void
{
    foreach ($diagnostics as $d) {
        echo "! {$d->rule} {$d->line} {$d->column}\n";
    }
}

/** Writes the hash and text of the case document set, or the diagnostics of a document or the set. */
function dbspec_write_manifest(string $dbspec, array $case): void
{
    $documents = dbspec_parse_document_set($dbspec, $case);
    if ($documents === null) {
        return;
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

/** Writes the statements of the case document set for each dialect, or the diagnostics of a document or the set. */
function dbspec_write_render(string $dbspec, array $case): void
{
    $documents = dbspec_parse_document_set($dbspec, $case, "render/{$case['id']}\n");
    if ($documents === null) {
        return;
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
 * Parses the documents of a case in name order, each with the other documents available as a set.
 *
 * @param array<string, mixed> $case
 * @return ?list<object>
 */
function dbspec_parse_document_set(string $dbspec, array $case, string $failurePrefix = ''): ?array
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
            echo $failurePrefix;
            dbspec_diagnostics($result->diagnostics);
            return null;
        }
        $documents[] = $result->document;
    }
    return $documents;
}

/**
 * The third word of the first line, the document name of a dbspec header split at single spaces, or null. @param
 * list<string> $lines
 */
function dbspec_header_name(array $lines): ?string
{
    return $lines === [] ? null : (explode(' ', $lines[0])[2] ?? null);
}

/**
 * Names each document of a sets case by its header; a header that names no document is refused.
 *
 * @param list<list<string>> $documents
 * @return list<array{name: string, lines: list<string>}>
 */
function dbspec_vector_named_documents(string $path, array $documents, string $at): array
{
    $named = [];
    foreach ($documents as $i => $lines) {
        $name = dbspec_header_name($lines);
        if ($name === null) {
            dbspec_vector_fail($path, "{$at}[$i][0]", 'has no document name');
        }
        $named[] = ['name' => $name, 'lines' => $lines];
    }
    return $named;
}

/**
 * Reads the recipe file $path and checks it against the recipe schema (scripts/features/schema/recipe.schema.json), and
 * returns the whole file with objects as associative arrays. A refusal is written to stderr, one line per problem, and
 * ends with 1.
 *
 * @return array<string, mixed>
 */
function dbspec_read_recipe_file(string $path): array
{
    $text = dbspec_read_input($path);
    $value = dbspec_decode_input($path, $text);
    $schema = json_decode(
        (string) file_get_contents(ormRepositoryRoot() . '/scripts/features/schema/recipe.schema.json'),
        false,
        512,
        JSON_THROW_ON_ERROR
    );
    $validator = new \Opis\JsonSchema\Validator(max_errors: PHP_INT_MAX, stop_at_first_error: false);
    $error = $validator->validate($value, $schema)->error();
    if ($error !== null) {
        foreach (dbspec_vector_leaves($error) as $leaf) {
            foreach (dbspec_vector_problems($leaf) as $problem) {
                fwrite(STDERR, "$path: $problem\n");
            }
        }
        exit(1);
    }
    return json_decode($text, true, 512, JSON_THROW_ON_ERROR);
}

/**
 * Reads a recipe file of tests/dbspec (canonical.json, normalize.json, invalid.json, positions.json or files.json)
 * against the recipe schema (scripts/features/schema/recipe.schema.json) and returns its cases, each with the step of
 * $op: the main document is the step's text, named "main", with the other documents of its set. A refusal is written to
 * stderr, one line per problem, and ends with 1.
 *
 * @return list<array<string, mixed>>
 */
function dbspec_read_recipe(string $path, string $op): array
{
    $file = dbspec_read_recipe_file($path);
    $cases = [];
    foreach ($file['cases'] as $i => $case) {
        $step = null;
        foreach ($case['steps'] as $candidate) {
            if ($candidate['op'] === $op) {
                $step = $candidate;
                break;
            }
        }
        if ($step === null) {
            dbspec_vector_fail($path, "cases[$i].steps", "has no $op step");
        }
        $documents = ['main' => $step['text'] ?? []];
        foreach ($step['set'] ?? [] as $name => $lines) {
            if ($name === 'main') {
                dbspec_vector_fail($path, "cases[$i].steps", 'names a document main, which is the main document');
            }
            $documents[$name] = $lines;
        }
        $cases[] = [
            'id' => $case['id'],
            'main' => 'main',
            'documents' => $documents,
            'crlf' => ($step['crlf'] ?? false) === true,
            'mixed' => ($step['mixed'] ?? false) === true,
            'path' => $step['path'] ?? '',
        ];
    }
    return $cases;
}

/**
 * Reads hashes.json or sets.json against the recipe schema. Its analyses come in file order, each with its id
 * (sets.<case>.<n>, or hashes.<case>.<name> for a hashes case), its text and its set of other documents. A hashes
 * case's documents are the owned texts of its dbspec.set step, each named by its header.
 *
 * @return array{
 *     cases: list<array{id: string, documents: array<string, list<string>>}>,
 *     analyses: list<array{0: string, 1: string, 2: array<string, string>}>
 * }
 */
function dbspec_read_set_recipe(string $path, string $kind): array
{
    $file = dbspec_read_recipe_file($path);
    $cases = [];
    $analyses = [];
    foreach ($file['cases'] as $case) {
        $documents = [];
        $n = 0;
        foreach ($case['steps'] as $step) {
            if ($step['op'] === 'dbspec.set') {
                $documents = [];
                foreach ($step['owned'] ?? [] as $text) {
                    $lines = explode("\n", str_ends_with($text, "\n") ? substr($text, 0, -1) : $text);
                    $documents[(string) dbspec_header_name($lines)] = $lines;
                }
            } elseif ($step['op'] === 'dbspec.analyze') {
                $n++;
                $lines = $step['text'];
                $id = $kind === 'hashes'
                    ? "hashes.{$case['id']}." . (dbspec_header_name($lines) ?? '')
                    : "sets.{$case['id']}.$n";
                $set = [];
                foreach ($step['set'] ?? [] as $other => $otherLines) {
                    $set[$other] = dbspec_join($otherLines, false, false);
                }
                $analyses[] = [$id, dbspec_join($lines, false, false), $set];
            }
        }
        if ($kind === 'hashes') {
            $cases[] = ['id' => $case['id'], 'documents' => $documents];
        }
    }
    return ['cases' => $cases, 'analyses' => $analyses];
}

/**
 * With $dbspec, writes the canonical, normalize, invalid, stress document, and files cases of tests/dbspec/cases.json,
 * the hashes case, and the tests/dbspec/ddl.json rendering, in this order. The vector file is checked before output
 * its shape, and an invalid vector is reported with its location to stderr and exits with 1. It returns the cases it
 * read, which dbspec_write_positions and dbspec_write_syntax print.
 *
 * @return array<string, list<array<string, mixed>>>
 */
function dbspec_write_interface(string $dbspec, string $recipeDir, string $stressPath, string $ddlPath): array
{
    // A recipes directory that is not a directory is refused with its path before any of its files is read.
    if (!is_dir($recipeDir)) {
        $reason = file_exists($recipeDir) ? 'is not a directory' : 'no such directory';
        fwrite(STDERR, "$recipeDir: $reason\n");
        exit(1);
    }
    $cases = [];
    $cases['canonical'] = dbspec_read_recipe($recipeDir . '/canonical.json', 'dbspec.format');
    $cases['normalize'] = dbspec_read_recipe($recipeDir . '/normalize.json', 'dbspec.format');
    $cases['invalid'] = dbspec_read_recipe($recipeDir . '/invalid.json', 'dbspec.format');
    $cases['positions'] = dbspec_read_recipe($recipeDir . '/positions.json', 'dbspec.parse_positions');
    $cases['files'] = dbspec_read_recipe($recipeDir . '/files.json', 'dbspec.read_file');
    $hashes = dbspec_read_set_recipe($recipeDir . '/hashes.json', 'hashes');
    $sets = dbspec_read_set_recipe($recipeDir . '/sets.json', 'sets');
    $cases['hashes'] = $hashes['cases'];
    $cases['analyses'] = [...$sets['analyses'], ...$hashes['analyses']];

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
    // The files case reads with $dbspec::readFile given the path as "files/<id>", and with $dbspec::readBytes given the
    // file bytes and the case path as the name, as "files/<id>/bytes", and writes the diagnostic and its message
    // or, if there is none, the emission. The name before the message is written as "<name>".
    foreach ($cases['files'] as $case) {
        $path = $recipeDir . '/' . $case['path'];
        try {
            $reads = [
                "files/{$case['id']}" => [$path, $dbspec::readFile($path)],
                "files/{$case['id']}/bytes" => [
                    $case['path'],
                    $dbspec::readBytes($case['path'], (string) file_get_contents($path))
                ],
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
                echo '= ' . (
                    str_starts_with($d->message, $name) ? '<name>' . substr($d->message, strlen($name)) : $d->message
                ) . "\n";
            }
        }
    }

    foreach ($cases['hashes'] as $case) {
        echo "hashes/{$case['id']}\n";
        dbspec_write_manifest($dbspec, $case);
    }

    $ddl = dbspec_read_vectors($ddlPath, 'ddl')['cases'];
    foreach ($ddl as $case) {
        dbspec_write_render($dbspec, $case);
    }
    return $cases;
}

/**
 * Prints the declaration positions of the main document of each positions case, as
 * "| kind<TAB>line<TAB>column<TAB>path..." lines, or its diagnostics.
 *
 * @param array<string, list<array<string, mixed>>> $cases
 */
function dbspec_write_positions(string $dbspec, array $cases): void
{
    foreach ($cases['positions'] as $case) {
        echo "positions/{$case['id']}\n";
        $set = [];
        foreach ($case['documents'] as $name => $lines) {
            if ($name !== $case['main']) {
                $set[$name] = dbspec_join($lines, false, false);
            }
        }
        $result = $dbspec::parse(dbspec_join($case['documents'][$case['main']], false, false), $set);
        dbspec_diagnostics($result->diagnostics);
        foreach ($result->positions ?? [] as $p) {
            echo '| ' . implode("\t", [$p->kind, $p->line, $p->column, ...$p->path]) . "\n";
        }
    }
}

/**
 * Prints each analysis of hashes.json and sets.json (after the recipe documents): its tokens ("| line start end class")
 * and the diagnostics of its analysis, then "syntax/<id>/format" and the formatted text or the diagnostics of the
 * refusal.
 *
 * @param array<string, mixed> $cases
 */
function dbspec_write_syntax(string $dbspec, array $cases): void
{
    $ids = [];
    foreach (['canonical', 'normalize', 'invalid'] as $kind) {
        foreach ($cases[$kind] as $case) {
            $dbspecId = "$kind.{$case['id']}";
            $text = dbspec_join($case['documents'][$case['main']], $case['crlf'], $case['mixed']);
            $set = [];
            foreach ($case['documents'] as $name => $lines) {
                if ($name !== $case['main']) {
                    $set[$name] = dbspec_join($lines, $case['crlf'], $case['mixed']);
                }
            }
            $ids[] = [$dbspecId, $text, $set];
        }
    }
    foreach ([...$ids, ...$cases['analyses']] as [$id, $text, $set]) {
        echo "syntax/$id\n";
        $analysis = $dbspec::analyze($text, $set);
        foreach ($analysis->tokens as $t) {
            echo "| {$t->line} {$t->start} {$t->end} {$t->class}\n";
        }
        dbspec_diagnostics($analysis->diagnostics);
        echo "syntax/$id/format\n";
        $formatted = $dbspec::format($text, $set);
        dbspec_diagnostics($formatted->diagnostics);
        if ($formatted->text !== null) {
            foreach (explode("\n", $formatted->text) as $line) {
                echo "| $line\n";
            }
        }
    }
}

/** Runs the shared PHP dbspec comparison output sequence for the six runner inputs. @param list<string> $inputs */
function dbspec_write_comparison(string $dbspec, array $inputs): void
{
    $cases = dbspec_write_interface($dbspec, $inputs[0], $inputs[1], $inputs[2]);
    dbspec_write_plans($dbspec, $inputs[3]);
    dbspec_write_mermaid($dbspec, $inputs[4]);
    dbspec_write_positions($dbspec, $cases);
    dbspec_write_syntax($dbspec, $cases);
}

/** Writes one step as a statement line and its attribute lines (tests/dbspec/compare/check.mts). */
function dbspec_step(object $s): void
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

/**
  * Writes the diagnostic. Plan, chain and compare diagnostics end in a message shared by all clients,
  * while the target or source schema diagnostics do not.
 *
 * @param list<object> $diagnostics
 */
function dbspec_plan_diagnostics(array $diagnostics): void
{
    foreach ($diagnostics as $d) {
        echo in_array(
            $d->rule,
            ['plan', 'chain', 'compare'],
            true
        ) ? "! {$d->rule} {$d->line} {$d->column} {$d->message}\n" : "! {$d->rule} {$d->line} {$d->column}\n";
    }
}

/**
  * the source schema of the plan case; null if the schema is empty, false if a diagnostic was written.
 *
 * @param ?list<string> $lines
 */
function dbspec_plan_source(string $dbspec, ?array $lines): object|null|false
{
    if ($lines === null) {
        return null;
    }
    $result = $dbspec::parse(dbspec_join($lines, false, false), []);
    if ($result->document === null) {
        dbspec_plan_diagnostics($result->diagnostics);
        return false;
    }
    return $result->document;
}

/** Writes each change as "| kind table name". @param list<object> $changes */
function dbspec_changes(array $changes): void
{
    foreach ($changes as $c) {
        echo "| {$c->kind} {$c->table} {$c->name}\n";
    }
}

/** Writes the lines of the emitted plan. */
function dbspec_emitted_plan(string $dbspec, object $plan): void
{
    foreach (explode("\n", $dbspec::emitPlan($plan)) as $line) {
        echo "| $line\n";
    }
}

/**
 * The validation sections of plan-cases.json as the compare reads them: the recipes of plansPath (plan-invalid,
 * plan-chains, plan-parse and plan-comparisons .json) give the lines of each case in the shape of the section that
 * each replaces. A ref that binds no lines fails the run.
 *
 * @return array{invalid: list<array{id: string, source: ?list<string>, plan: list<string>}>,
 *     chains: list<array{id: string, plans: list<list<string>>}>, parse: list<array{id: string, plan: list<string>}>,
 *     comparisons: list<array{id: string, source: list<string>, target: list<string>}>}
 */
function dbspec_plan_recipes(string $plansPath): array
{
    $dir = dirname($plansPath);
    $recipes = [];
    foreach (['invalid', 'chains', 'parse', 'comparisons'] as $section) {
        $recipes[$section] = json_decode(
            dbspec_read_input("$dir/plan-$section.json"),
            true,
            512,
            JSON_THROW_ON_ERROR
        );
    }
    $named = static function (mixed $raw, array $bound): ?array {
        if ($raw === null) {
            return null;
        }
        return $bound[$raw['ref']] ?? throw new RuntimeException("ref {$raw['ref']} names no parsed schema or plan");
    };
    $required = static function (mixed $raw, array $bound) use ($named): array {
        return $named($raw, $bound)
            ?? throw new RuntimeException('a recipe step names the empty schema where lines are needed');
    };
    $cases = static function (array $recipe, string $op, callable $read) use ($named): array {
        $out = [];
        foreach ($recipe['cases'] as $case) {
            $bound = [];
            foreach ($case['steps'] as $step) {
                if (($step['op'] === 'dbspec.parse' || $step['op'] === 'dbspec.parse_plan') && isset($step['as'])) {
                    $bound[$step['as']] = $step['lines'] ?? [];
                }
            }
            foreach ($case['steps'] as $step) {
                if ($step['op'] === $op) {
                    $out[] = $read($step, $bound, $case['id']);
                }
            }
        }
        return $out;
    };
    return [
        'invalid' => $cases($recipes['invalid'], 'dbspec.diff', static fn(array $s, array $b, string $id): array => [
            'id' => $id,
            'source' => $named($s['source'] ?? null, $b),
            'plan' => $required($s['plan'], $b),
        ]),
        'chains' => $cases($recipes['chains'], 'dbspec.chain', static fn(array $s, array $b, string $id): array => [
            'id' => $id,
            'plans' => array_map(static fn(mixed $raw): array => $required($raw, $b), $s['plans'] ?? []),
        ]),
        'parse' => $cases($recipes['parse'], 'dbspec.parse_plan', static fn(array $s, array $b, string $id): array => [
            'id' => $id,
            'plan' => $s['lines'] ?? [],
        ]),
        'comparisons' => $cases(
            $recipes['comparisons'],
            'dbspec.compare',
            static fn(array $s, array $b, string $id): array => [
                'id' => $id,
                'source' => $required($s['source'], $b),
                'target' => $required($s['target'], $b),
            ]
        ),
    ];
}

/**
 * With $dbspec, writes the case, invalid, chain, parse and comparison of tests/dbspec/plan-cases.json in this order:
 * the cases section of the file, and the other four from the recipes beside it (dbspec_plan_recipes). The vector file
 * is checked for its shape before output.
 */
function dbspec_write_plans(string $dbspec, string $plansPath): void
{
    // The plans file is read against its schema first, so an unreadable or refused file is refused as every input is.
    $vectors = dbspec_read_vectors($plansPath, 'plans');
    $cases = plan_vectors_at($plansPath)['cases'];
    // The cases of the read cases replace the recipe cases of the file: the left operand of + keeps its keys.
    $plans = ['cases' => $cases] + dbspec_plan_recipes($plansPath) + $vectors;
    foreach ($plans['cases'] as $case) {
        echo "plans/cases/{$case['id']}\n";
        $input = dbspec_case_plan($dbspec, $case);
        if ($input === false) {
            continue;
        }
        [$source, $plan] = $input;
        dbspec_emitted_plan($dbspec, $plan);
        echo "plans/cases/{$case['id']}/changes\n";
        $diff = $dbspec::diff($source, $plan);
        dbspec_plan_diagnostics($diff->diagnostics);
        dbspec_changes($diff->changes ?? []);
        foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
            echo "plans/cases/{$case['id']}/$dialect\n";
            $result = $dbspec::planSteps($source, $plan, $dialect);
            dbspec_plan_diagnostics($result->diagnostics);
            foreach ($result->steps ?? [] as $step) {
                dbspec_step($step);
            }
        }
    }
    foreach ($plans['invalid'] as $case) {
        echo "plans/invalid/{$case['id']}\n";
        $input = dbspec_case_plan($dbspec, $case);
        if ($input === false) {
            continue;
        }
        [$source, $plan] = $input;
        $diff = $dbspec::diff($source, $plan);
        dbspec_plan_diagnostics($diff->diagnostics);
        dbspec_changes($diff->changes ?? []);
    }
    foreach ($plans['chains'] as $case) {
        echo "plans/chains/{$case['id']}\n";
        $parsedPlans = [];
        foreach ($case['plans'] as $lines) {
            $parsedPlans[] = dbspec_parse_plan($dbspec, $lines);
        }
        if (in_array(null, $parsedPlans, true)) {
            continue;
        }
        $chain = $dbspec::chain($parsedPlans);
        dbspec_plan_diagnostics($chain->diagnostics);
        foreach ($chain->plans ?? [] as $plan) {
            echo "| {$plan->name}\n";
        }
    }
    foreach ($plans['parse'] as $case) {
        echo "plans/parse/{$case['id']}\n";
        $plan = dbspec_parse_plan($dbspec, $case['plan']);
        if ($plan === null) {
            continue;
        }
        dbspec_emitted_plan($dbspec, $plan);
    }
    foreach ($plans['comparisons'] as $case) {
        echo "plans/comparisons/{$case['id']}\n";
        $source = $dbspec::parse(dbspec_join($case['source'], false, false), []);
        dbspec_plan_diagnostics($source->diagnostics);
        $target = $dbspec::parse(dbspec_join($case['target'], false, false), []);
        dbspec_plan_diagnostics($target->diagnostics);
        if ($source->document === null || $target->document === null) {
            continue;
        }
        $result = $dbspec::compareSchemas($source->document, $target->document);
        dbspec_plan_diagnostics($result->diagnostics);
        foreach ($result->differences ?? [] as $d) {
            echo "| {$d->kind} {$d->table} {$d->name}\n";
        }
    }
}

/** Parses plan lines and writes all diagnostics in the format of the comparison runner. */
function dbspec_parse_plan(string $dbspec, array $lines): ?object
{
    $result = $dbspec::parsePlan(dbspec_join($lines, false, false));
    dbspec_plan_diagnostics($result->diagnostics);
    return $result->plan;
}

/** @return array{object|null, object}|false */
function dbspec_case_plan(string $dbspec, array $case): array|false
{
    $source = dbspec_plan_source($dbspec, $case['source']);
    if ($source === false) {
        return false;
    }
    $plan = dbspec_parse_plan($dbspec, $case['plan']);
    return $plan === null ? false : [$source, $plan];
}

/**
 * Writes what export or import dropped as "= kind<TAB>table<TAB>name", and does not compare the reasons. @param
 * list<object> $dropped
 */
function dbspec_dropped(array $dropped): void
{
    foreach ($dropped as $u) {
        echo "= {$u->kind}\t{$u->table}\t{$u->name}\n";
    }
}

/** Writes the document's Mermaid text and the missing objects, and returns the text. */
function dbspec_export(string $dbspec, object $document): string
{
    $result = $dbspec::exportMermaid($document);
    foreach (explode("\n", $result->text) as $line) {
        echo "| $line\n";
    }
    dbspec_dropped($result->dropped);
    return $result->text;
}

/**
 * With $dbspec, writes the cases of tests/dbspec/mermaid.json (the recipe, FCV-4) in case order, the same way as the
 * TypeScript runner. Paths are relative to the directory of the recipe file.
 */
function dbspec_write_mermaid(string $dbspec, string $mermaidPath): void
{
    $recipe = dbspec_read_vectors($mermaidPath, 'mermaid');
    foreach ($recipe['cases'] as $case) {
        dbspec_mermaid_case($dbspec, $case, dirname($mermaidPath));
    }
}

/**
 * Writes one case of the recipe: its category and id, then the output of each step, in order. An export prints its
 * Mermaid text and the missing objects; an import prints the emitted document and the missing objects, or its
 * diagnostics; an import with skeleton_of prints whether the skeleton of its document is that of the file. A step with
 * as binds its Mermaid text, which a ref of a later import reads.
 */
function dbspec_mermaid_case(string $dbspec, array $case, string $dir): void
{
    $roundTrip = array_filter($case['steps'], static fn(array $step): bool => isset($step['skeleton_of'])) !== [];
    $texts = [];
    foreach ($case['steps'] as $step) {
        if ($step['op'] === 'dbspec.export_mermaid') {
            echo 'mermaid/' . ($roundTrip ? 'round_trip' : 'export') . "/{$case['id']}\n";
            // The inline text and the other documents of its set, or the .dbs file document (FCV-4).
            $source = dbspec_join($step['text'] ?? [], false, false);
            $set = array_map(static fn(array $lines): string => dbspec_join($lines, false, false), $step['set'] ?? []);
            if (isset($step['document'])) {
                $read = $dbspec::readFile("$dir/{$step['document']}");
                if ($read->text === null) {
                    dbspec_plan_diagnostics($read->diagnostics);
                    return;
                }
                [$source, $set] = [$read->text, []];
            }
            $parsed = $dbspec::parse($source, $set);
            if ($parsed->document === null) {
                dbspec_plan_diagnostics($parsed->diagnostics);
                return;
            }
            $text = dbspec_export($dbspec, $parsed->document);
            if (isset($step['as'])) {
                $texts[$step['as']] = $text;
            }
            continue;
        }
        $ref = is_string($step['mermaid']) ? null : explode('.', $step['mermaid']['ref'], 2)[0];
        $text = $ref === null ? $step['mermaid'] : ($texts[$ref] ?? '');
        $result = $dbspec::importMermaid($text, $step['name'] ?? '');
        if ($result->document === null) {
            echo "mermaid/invalid/{$case['id']}\n";
            dbspec_plan_diagnostics($result->diagnostics);
            continue;
        }
        if (isset($step['skeleton_of'])) {
            echo "mermaid/round_trip/{$case['id']}/import\n";
            $read = $dbspec::readFile("$dir/{$step['skeleton_of']}");
            if ($read->text === null) {
                dbspec_plan_diagnostics($read->diagnostics);
                return;
            }
            $original = $dbspec::parse($read->text, []);
            if ($original->document === null) {
                dbspec_plan_diagnostics($original->diagnostics);
                return;
            }
            $same = dbspec_mermaid_skeleton($original->document) === dbspec_mermaid_skeleton($result->document);
            echo "| same_skeleton\t" . ($same ? 'true' : 'false') . "\n";
            dbspec_dropped($result->dropped);
            continue;
        }
        echo "mermaid/import/{$case['id']}\n";
        foreach (explode("\n", $dbspec::emit($result->document)) as $line) {
            echo "| $line\n";
        }
        dbspec_dropped($result->dropped);
    }
}

/**
 * Writes the tables, columns, primary keys and foreign keys that Mermaid carries, as lines in table
 * name order; foreign key actions are left out, since Mermaid does not carry them.
 *
 * @return list<string>
 */
function dbspec_mermaid_skeleton(object $document): array
{
    $byName = static fn(object $a, object $b): int => strcmp($a->name, $b->name);
    $tables = $document->tables;
    usort($tables, $byName);
    $lines = [];
    foreach ($tables as $t) {
        $lines[] = "table {$t->name}";
        foreach ($t->columns as $c) {
            $dflt = $c->default ?? '-';
            $lines[] = "column {$c->name} {$c->type->text()} null=" . ($c->nullable ? 'true' : 'false')
                . ' identity=' . ($c->identity ? 'true' : 'false') . " default=$dflt";
        }
        $lines[] = 'primary key ' . implode(', ', $t->primaryKey->columns);
        $foreignKeys = $t->foreignKeys;
        usort($foreignKeys, $byName);
        foreach ($foreignKeys as $f) {
            $lines[] = "foreign key {$f->name} (" . implode(', ', $f->columns) . ") references {$f->table} ("
                . implode(', ', $f->referencedColumns) . ')';
        }
    }
    return $lines;
}
