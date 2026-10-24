<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

/** @param list<string> $statements */
function dbspec_php_interface_program(string $root, array $statements): string
{
    return implode("\n", [
        'require ' . var_export("$root/vendor-php/autoload.php", true) . ';',
        'require ' . var_export("$root/tests/dbspec/input.php", true) . ';',
        'require ' . var_export("$root/tests/dbspec/vectors.php", true) . ';',
        'require ' . var_export("$root/tests/dbspec/cases.php", true) . ';',
        'require ' . var_export("$root/packages/php/testing/dbspec/compare/php-interface.php", true) . ';',
        ...$statements,
    ]);
}
