<?php
declare(strict_types=1);
// The set parse Dbspec::parseSet (docs/dbspec.md "Parsing a set") through the shared vectors
// tests/dbspec/set-parse.json; each parsed text equals one Dbspec::parse of it with the other named texts.
// Usage: php packages/php/tests/dbspec_set_parse_test.php
require __DIR__ . '/autoload.php';
require __DIR__ . '/dbspec_set_parse_cases.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';

use Polyspec\Orm\Dbspec\Dbspec;

$root = dirname(__DIR__, 3);
$count = dbspec_set_parse_run($root, 'dbspec_set_parse', static fn(array $owned, array $external): array => Dbspec::parseSet($owned, $external), static function (array $result, array $case): void {
    $texts = [...$case['owned'], ...$case['external']];
    $named = [];
    $repeated = [];
    foreach ($result as $i => $d) {
        if ($d->name === '') {
            continue;
        }
        if (isset($named[$d->name])) {
            $repeated[$i] = true;
        } else {
            $named[$d->name] = $i;
        }
    }
    foreach ($result as $i => $d) {
        if (isset($repeated[$i])) {
            continue;
        }
        $others = [];
        foreach ($named as $name => $j) {
            if ($name !== $d->name) {
                $others[$name] = $texts[$j];
            }
        }
        $one = Dbspec::parse($texts[$i], $others);
        if ($one->document !== null) {
            $one->document->external = $d->external;
        }
        if (json_encode([$one->document, $one->positions, $one->diagnostics]) !== json_encode([$d->document, $d->positions, $d->diagnostics])) {
            throw new RuntimeException("text $i differs from one parse of it");
        }
    }
});
echo "dbspec set parse: $count vector cases\n";
