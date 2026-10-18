<?php

declare(strict_types=1);

// Reads the vectors and writes the output shared by the dbspec compare runners (php.php, php-extension.php). The output functions take a Dbspec class
// (Polyspec\Orm\Dbspec\Dbspec or the extension's Polyspec\Orm\Dbspec\Native\Dbspec) and write in the line format of tests/dbspec/compare/check.mts:
// dbspec_write_interface writes the shared cases, stress documents, file reads, manifest and statement vectors,
// dbspec_write_plans writes the plan vectors, and dbspec_write_mermaid writes the Mermaid vectors. The two classes have the same methods and result
// shape.

require_once __DIR__ . '/../../../../../tests/dbspec/input.php';
require_once __DIR__ . '/../../../../../tests/dbspec/cases.php';

/** Writes the location and problem of a vector file to stderr and exits with 1. */
function dbspec_vector_fail(string $path, string $location, string $problem): never
{
    fwrite(STDERR, "$path: $location $problem\n");
    exit(1);
}

/**
 * Reads the vector file at $path against the schema tests/dbspec/schema/$kind.schema.json (tests/dbspec/vectors.php) and
 * returns it with objects as associative arrays; a refusal is written to stderr, one line per problem, and ends with 1.
 *
 * @return array<string, mixed>
 */
function dbspec_read_vectors(string $path, string $kind): array
{
    $text = dbspec_read_input($path);
    try {
        $value = json_decode($text, false, 512, JSON_THROW_ON_ERROR);
    } catch (JsonException $e) {
        fwrite(STDERR, "$path: {$e->getMessage()}\n");
        exit(1);
    }
    try {
        $kind === 'cases' ? dbspec_check_cases($value, $path) : dbspec_check_vectors($value, $kind, $path);
    } catch (RuntimeException $e) {
        fwrite(STDERR, $e->getMessage() . "\n");
        exit(1);
    }
    return json_decode($text, true, 512, JSON_THROW_ON_ERROR);
}

/**
  * Joins the lines with LF, with CRLF if $crlf, or alternating CRLF and LF if $mixed, with no line ending after the last line.
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

/** Writes the diagnostics of $text parsed with $dbspec, or its emission if there are none. @param array<string, string> $set */
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

/** Writes the statements of the case document set for each dialect, or the diagnostics of a document or the set. */
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

/** The third word of the first line, the document name of a dbspec header split at single spaces, or null. @param list<string> $lines */
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
 * With $dbspec, writes the canonical, normalize, invalid, stress document, and files cases of tests/dbspec/cases.json,
 * the hashes case, and the tests/dbspec/ddl.json rendering, in this order. The vector file is checked before output
 * its shape, and an invalid vector is reported with its location to stderr and exits with 1. It returns the cases it read, which
 * dbspec_write_positions and dbspec_write_syntax print.
 *
 * @return array<string, list<array<string, mixed>>>
 */
function dbspec_write_interface(string $dbspec, string $casesPath, string $stressPath, string $ddlPath): array
{
    // cases.json is read against its schema (tests/dbspec/cases.php): a missing or unknown section or field is refused.
    $cases = dbspec_read_vectors($casesPath, 'cases');
    foreach (['canonical', 'normalize', 'invalid'] as $kind) {
        $cases[$kind] = array_map(static fn(array $case): array => $case + ['crlf' => false, 'mixed' => false], $cases[$kind]);
    }
    foreach ($cases['sets'] as $i => $case) {
        $cases['sets'][$i]['documents'] = dbspec_vector_named_documents($casesPath, $case['documents'], "sets[$i].documents");
        $cases['sets'][$i]['external'] = dbspec_vector_named_documents($casesPath, $case['external'] ?? [], "sets[$i].external");
    }

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
    // The files case reads with $dbspec::readFile given the path as "files/<id>", and with $dbspec::readBytes given the file
    // bytes and the case path as the name, as "files/<id>/bytes", and writes the diagnostic and its message
    // or, if there is none, the emission. The name before the message is written as "<name>".
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
 * The input of every analysis that syntax.json names, by its id, as scripts/dbspec/syntax-vectors.mts derives it from
 * cases.json: the main document of each canonical, normalize and invalid case ("<section>.<id>"), each document of a
 * sets case with the parsing documents and the other documents of the case by header name ("sets.<id>.<place>",
 * 1-based), and each document of a hashes case with the others ("hashes.<id>.<name>").
 *
 * @param array<string, list<array<string, mixed>>> $cases
 * @return array<string, array{0: string, 1: array<string, string>}>
 */
function dbspec_syntax_inputs(array $cases): array
{
    $inputs = [];
    foreach (['canonical', 'normalize', 'invalid'] as $kind) {
        foreach ($cases[$kind] as $case) {
            $set = [];
            foreach ($case['documents'] as $name => $lines) {
                if ($name !== $case['main']) {
                    $set[$name] = dbspec_join($lines, $case['crlf'], $case['mixed']);
                }
            }
            $inputs["$kind.{$case['id']}"] = [dbspec_join($case['documents'][$case['main']], $case['crlf'], $case['mixed']), $set];
        }
    }
    foreach ($cases['sets'] as $case) {
        $every = [...$case['documents'], ...$case['external']];
        foreach ($case['documents'] as $i => $document) {
            $set = [];
            foreach ($case['parsing'] as $name => $lines) {
                $set[$name] = dbspec_join($lines, false, false);
            }
            foreach ($every as $j => $other) {
                if ($j !== $i) {
                    $set[$other['name']] = dbspec_join($other['lines'], false, false);
                }
            }
            $inputs["sets.{$case['id']}." . ($i + 1)] = [dbspec_join($document['lines'], false, false), $set];
        }
    }
    foreach ($cases['hashes'] as $case) {
        foreach ($case['documents'] as $name => $lines) {
            $set = [];
            foreach ($case['documents'] as $other => $otherLines) {
                if ($other !== $name) {
                    $set[$other] = dbspec_join($otherLines, false, false);
                }
            }
            $inputs["hashes.{$case['id']}.$name"] = [dbspec_join($lines, false, false), $set];
        }
    }
    return $inputs;
}

/**
 * Prints each case of syntax.json: its tokens ("| line start end class") and the diagnostics of its analysis, then
 * "syntax/<id>/format" and the formatted text or the diagnostics of the refusal. The expected tokens of the file are
 * the runtime tests' to check; this runner compares what each client gives.
 *
 * @param array<string, list<array<string, mixed>>> $cases
 */
function dbspec_write_syntax(string $dbspec, array $cases, string $syntaxPath): void
{
    $ids = dbspec_read_vectors($syntaxPath, 'syntax')['cases'];
    $inputs = dbspec_syntax_inputs($cases);
    foreach ($ids as $i => ['id' => $id]) {
        if (!array_key_exists($id, $inputs)) {
            dbspec_vector_fail($syntaxPath, "cases[$i].id", 'names no input of the shared cases');
        }
    }
    foreach ($ids as ['id' => $id]) {
        [$text, $set] = $inputs[$id];
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
        echo in_array($d->rule, ['plan', 'chain', 'compare'], true) ? "! {$d->rule} {$d->line} {$d->column} {$d->message}\n" : "! {$d->rule} {$d->line} {$d->column}\n";
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
 * With $dbspec, writes the case, invalid, chain, parse and comparison of tests/dbspec/plans.json in this order. The vector file
 * is checked for its shape before output.
 */
function dbspec_write_plans(string $dbspec, string $plansPath): void
{
    $plans = dbspec_read_vectors($plansPath, 'plans');
    foreach ($plans['cases'] as $case) {
        echo "plans/cases/{$case['id']}\n";
        $source = dbspec_plan_source($dbspec, $case['source']);
        if ($source === false) {
            continue;
        }
        $parsed = $dbspec::parsePlan(dbspec_join($case['plan'], false, false));
        if ($parsed->plan === null) {
            dbspec_plan_diagnostics($parsed->diagnostics);
            continue;
        }
        dbspec_emitted_plan($dbspec, $parsed->plan);
        echo "plans/cases/{$case['id']}/changes\n";
        $diff = $dbspec::diff($source, $parsed->plan);
        dbspec_plan_diagnostics($diff->diagnostics);
        dbspec_changes($diff->changes ?? []);
        foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
            echo "plans/cases/{$case['id']}/$dialect\n";
            $result = $dbspec::planSteps($source, $parsed->plan, $dialect);
            dbspec_plan_diagnostics($result->diagnostics);
            foreach ($result->steps ?? [] as $step) {
                dbspec_step($step);
            }
        }
    }
    foreach ($plans['invalid'] as $case) {
        echo "plans/invalid/{$case['id']}\n";
        $source = dbspec_plan_source($dbspec, $case['source']);
        if ($source === false) {
            continue;
        }
        $parsed = $dbspec::parsePlan(dbspec_join($case['plan'], false, false));
        if ($parsed->plan === null) {
            dbspec_plan_diagnostics($parsed->diagnostics);
            continue;
        }
        $diff = $dbspec::diff($source, $parsed->plan);
        dbspec_plan_diagnostics($diff->diagnostics);
        dbspec_changes($diff->changes ?? []);
    }
    foreach ($plans['chains'] as $case) {
        echo "plans/chains/{$case['id']}\n";
        $parsedPlans = [];
        foreach ($case['plans'] as $lines) {
            $parsed = $dbspec::parsePlan(dbspec_join($lines, false, false));
            dbspec_plan_diagnostics($parsed->diagnostics);
            $parsedPlans[] = $parsed->plan;
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
        $parsed = $dbspec::parsePlan(dbspec_join($case['plan'], false, false));
        if ($parsed->plan === null) {
            dbspec_plan_diagnostics($parsed->diagnostics);
            continue;
        }
        dbspec_emitted_plan($dbspec, $parsed->plan);
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

/** Writes what export or import dropped as "= kind<TAB>table<TAB>name", and does not compare the reasons. @param list<object> $dropped */
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

/** Writes the emitted document of the import and the missing objects, or the diagnostics. */
function dbspec_import(string $dbspec, string $text): void
{
    $result = $dbspec::importMermaid($text, 'imported');
    if ($result->document === null) {
        dbspec_plan_diagnostics($result->diagnostics);
        return;
    }
    foreach (explode("\n", $dbspec::emit($result->document)) as $line) {
        echo "| $line\n";
    }
    dbspec_dropped($result->dropped);
}

/** With $dbspec, writes the export, import, invalid and round trip cases of tests/dbspec/mermaid.json in this order. */
function dbspec_write_mermaid(string $dbspec, string $mermaidPath): void
{
    $mermaid = dbspec_read_vectors($mermaidPath, 'mermaid');
    foreach ($mermaid['export'] as $case) {
        echo "mermaid/export/{$case['id']}\n";
        $set = array_map(static fn(array $lines): string => dbspec_join($lines, false, false), $case['documents']);
        $parsed = $dbspec::parse(dbspec_join($case['document'], false, false), $set);
        if ($parsed->document === null) {
            dbspec_plan_diagnostics($parsed->diagnostics);
            continue;
        }
        dbspec_export($dbspec, $parsed->document);
    }
    foreach (['import', 'invalid'] as $kind) {
        foreach ($mermaid[$kind] as $case) {
            echo "mermaid/$kind/{$case['id']}\n";
            dbspec_import($dbspec, dbspec_join($case['mermaid'], false, false));
        }
    }
    foreach ($mermaid['round_trip'] as $case) {
        echo "mermaid/round_trip/{$case['id']}\n";
        try {
            $read = $dbspec::readFile($case['path']);
        } catch (RuntimeException $e) {
            fwrite(STDERR, $e->getMessage() . "\n");
            exit(1);
        }
        if ($read->text === null) {
            dbspec_plan_diagnostics($read->diagnostics);
            continue;
        }
        $parsed = $dbspec::parse($read->text, []);
        if ($parsed->document === null) {
            dbspec_plan_diagnostics($parsed->diagnostics);
            continue;
        }
        $text = dbspec_export($dbspec, $parsed->document);
        echo "mermaid/round_trip/{$case['id']}/import\n";
        dbspec_import($dbspec, $text);
    }
}
