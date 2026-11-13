<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

/** @param list<string> $statements */
function dbspec_php_interface_program(array $statements): string
{
    $repository = ormRepositoryRoot();
    $root = ormLegacyRoot();
    return implode("\n", [
        'require ' . var_export("$repository/vendor-php/autoload.php", true) . ';',
        'require ' . var_export("$repository/tests/dbspec/input.php", true) . ';',
        'require ' . var_export("$repository/tests/dbspec/vectors.php", true) . ';',
        'require_once ' . var_export("$root/packages/php/tests/repository_root.php", true) . ';',
        'require ' . var_export("$root/packages/php/tests/dbspec_plan_cases.php", true) . ';',
        'require ' . var_export("$root/packages/php/testing/dbspec/compare/php-interface.php", true) . ';',
        ...$statements,
    ]);
}
