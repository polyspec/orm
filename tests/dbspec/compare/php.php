<?php

declare(strict_types=1);

// Prints the PHP dbspec result of every shared case and of the stress
// document in the line format of tests/dbspec/compare/check.mjs.
//
// Usage: php tests/dbspec/compare/php.php <cases.json> <stress document> <ddl.json>

require __DIR__ . '/../../../clients/php/vendor/autoload.php';

if ($argc !== 4) {
    fwrite(STDERR, "usage: php tests/dbspec/compare/php.php <cases.json> <stress document> <ddl.json>\n");
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
