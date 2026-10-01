<?php

declare(strict_types=1);

// Prints the PHP dbspec result of every shared case, of the stress document,
// of the statement vectors and of the plan vectors in the line format of
// tests/dbspec/compare/check.mjs.
//
// Usage: php tests/dbspec/compare/php.php <cases.json> <stress document> <ddl.json> <plans.json>

require __DIR__ . '/../../../clients/php/vendor/autoload.php';

if ($argc !== 5) {
    fwrite(STDERR, "usage: php tests/dbspec/compare/php.php <cases.json> <stress document> <ddl.json> <plans.json>\n");
    exit(2);
}

/**
 * Writes the lines with LF, with CRLF when $crlf is true, or with alternating
 * CRLF and LF and no final line end when $mixed is true.
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

/** Prints the diagnostics of $text, or its emission when it has none. @param array<string, string> $set */
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

$cases = json_decode((string) file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR);
$stress = file_get_contents($argv[2]);
if ($stress === false) {
    fwrite(STDERR, "cannot read {$argv[2]}\n");
    exit(1);
}
foreach (['canonical', 'normalize', 'invalid'] as $kind) {
    foreach ($cases[$kind] as $case) {
        $crlf = ($case['crlf'] ?? false) === true;
        $mixed = ($case['mixed'] ?? false) === true;
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

/** Prints the diagnostics. @param list<Orm\Dbspec\Diagnostic> $diagnostics */
function dbspec_diagnostics(array $diagnostics): void
{
    foreach ($diagnostics as $d) {
        echo "! {$d->rule} {$d->line} {$d->column}\n";
    }
}

/** Prints the hashes and texts of the case's document set, or the diagnostics of a document or of the set. */
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

/** Prints the statements of the case's document set in every dialect, or the diagnostics of a document or of the set. */
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

$ddl = json_decode((string) file_get_contents($argv[3]), true, 512, JSON_THROW_ON_ERROR);
foreach ($ddl['cases'] as $case) {
    dbspec_write_render($case);
}

/**
 * Prints diagnostics; a plan or chain diagnostic ends with its message, which
 * every client shares, and a schema diagnostic of the target or source does not.
 *
 * @param list<Orm\Dbspec\Diagnostic> $diagnostics
 */
function dbspec_plan_diagnostics(array $diagnostics): void
{
    foreach ($diagnostics as $d) {
        echo $d->rule === 'plan' || $d->rule === 'chain' ? "! {$d->rule} {$d->line} {$d->column} {$d->message}\n" : "! {$d->rule} {$d->line} {$d->column}\n";
    }
}

/**
 * The source schema of a plan case, null for the empty schema, or false after
 * printing its diagnostics.
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

/** Prints the changes as "| kind table name". @param list<Orm\Dbspec\Change> $changes */
function dbspec_changes(array $changes): void
{
    foreach ($changes as $c) {
        echo "| {$c->kind} {$c->table} {$c->name}\n";
    }
}

/** Prints the lines of an emitted plan. */
function dbspec_emitted_plan(Orm\Dbspec\Plan $plan): void
{
    foreach (explode("\n", Orm\Dbspec\Dbspec::emitPlan($plan)) as $line) {
        echo "| $line\n";
    }
}

$plans = json_decode((string) file_get_contents($argv[4]), true, 512, JSON_THROW_ON_ERROR);
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
        $result = Orm\Dbspec\Dbspec::planStatements($source, $parsed->plan, $dialect);
        dbspec_plan_diagnostics($result->diagnostics);
        foreach ($result->statements ?? [] as $statement) {
            echo "| $statement\n";
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
