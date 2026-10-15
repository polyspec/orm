<?php
declare(strict_types=1);

// The sets cases of tests/dbspec/cases.json on the extension orm_dbspec (Polyspec\Orm\Dbspec\Native\Dbspec): each
// case, a data set named by its id, runs the PHP client's check (packages/php/tests/dbspec_sets_cases.php) through
// the extension's parse, manifest and render in every dialect.
// Usage: php -d extension=<orm_dbspec.so> vendor-php/bin/phpunit --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/DbspecSetsTest.php

use Polyspec\Orm\Dbspec\Native\Dbspec as NativeDbspec;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

require_once dirname(__DIR__, 3) . '/tests/dbspec/cases.php';
require_once dirname(__DIR__, 2) . '/php/tests/dbspec_sets_cases.php';

#[Small]
final class DbspecSetsTest extends TestCase
{
    public static function setsCases(): iterable
    {
        foreach (dbspec_read_cases()['sets'] as $case) {
            yield $case['id'] => [$case];
        }
    }

    #[DataProvider('setsCases')]
    public function test_sets(array $case): void
    {
        dbspec_sets_check(NativeDbspec::class, $case);
    }
}
