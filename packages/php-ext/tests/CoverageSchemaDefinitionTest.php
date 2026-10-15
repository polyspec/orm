<?php
declare(strict_types=1);

// schema_definition feature coverage on the extension orm_dbspec: every case of
// contracts/fixtures/schema_definition.json, each a test named by its id, runs
// the PHP client's coverage test (packages/php/tests/CoverageSchemaDefinitionTest.php)
// on Polyspec\Orm\Dbspec\Native\Dbspec.
// Usage: php -d extension=<orm_dbspec.so> vendor-php/bin/phpunit --configuration packages/php-ext/phpunit.xml.dist packages/php-ext/tests/CoverageSchemaDefinitionTest.php

namespace Polyspec\Orm\Tests\Extension;

use PHPUnit\Framework\Attributes\Small;
use Polyspec\Orm\Dbspec\Native\Dbspec as NativeDbspec;

require_once dirname(__DIR__, 2) . '/php/tests/CoverageSchemaDefinitionTest.php';

#[Small]
final class CoverageSchemaDefinitionTest extends \CoverageSchemaDefinitionTest
{
    protected static function dbspec(): string
    {
        return NativeDbspec::class;
    }
}
