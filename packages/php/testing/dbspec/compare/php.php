<?php

declare(strict_types=1);

// The PHP dbspec of all shared cases, stress documents, statement vectors, plan vectors and the Mermaid recipe
// results, written in the line format of tests/dbspec/compare/check.mts. It then prints the positions cases of
// tests/dbspec and the analysis and format of each analysis of hashes.json and sets.json.
//
// Usage: php packages/php/testing/dbspec/compare/php.php <tests/dbspec dir> <stress document> <ddl.json>
// <plan-cases.json> <mermaid.json>

require __DIR__ . '/../../../../../vendor-php/autoload.php';
require __DIR__ . '/../../../../../tests/dbspec/input.php';
require __DIR__ . '/../../../../../tests/dbspec/vectors.php';
require __DIR__ . '/../../../tests/dbspec_plan_cases.php';
require __DIR__ . '/php-interface.php';

if ($argc !== 6) {
    fwrite(
        STDERR,
        "usage: php packages/php/testing/dbspec/compare/php.php <tests/dbspec dir> <stress document> <ddl.json> "
        . "<plan-cases.json> <mermaid.json>\n"
    );
    exit(2);
}

dbspec_write_comparison(Polyspec\Orm\Dbspec\Dbspec::class, array_slice($argv, 1));
