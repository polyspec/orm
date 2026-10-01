<?php

declare(strict_types=1);

// Prints the PHP dbspec result of every shared case and of the stress
// document in the line format of tests/dbspec/compare/check.mjs.
//
// Usage: php tests/dbspec/compare/php.php <cases.json> <stress document>

require __DIR__ . '/../../../clients/php/vendor/autoload.php';

if ($argc !== 3) {
    fwrite(STDERR, "usage: php tests/dbspec/compare/php.php <cases.json> <stress document>\n");
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
