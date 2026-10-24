<?php

declare(strict_types=1);

// The PHP dbspec of all shared cases, stress documents, statement vectors, plan vectors and Mermaid vectors
// results, written in the line format of tests/dbspec/compare/check.mts. It then prints the positions cases of
// cases.json and the analysis and format of each case of syntax.json.
//
// Usage: php packages/php/testing/dbspec/compare/php.php <cases.json> <stress document> <ddl.json> <plans.json>
// <mermaid.json> <syntax.json>

require __DIR__ . '/../../../../../vendor-php/autoload.php';
require __DIR__ . '/../../../../../tests/dbspec/input.php';
require __DIR__ . '/../../../../../tests/dbspec/vectors.php';
require __DIR__ . '/../../../../../tests/dbspec/cases.php';
require __DIR__ . '/php-interface.php';

if ($argc !== 7) {
    fwrite(
        STDERR,
        "usage: php packages/php/testing/dbspec/compare/php.php <cases.json> <stress document> <ddl.json> "
        . "<plans.json> <mermaid.json> <syntax.json>\n"
    );
    exit(2);
}

dbspec_write_comparison(Polyspec\Orm\Dbspec\Dbspec::class, array_slice($argv, 1));
