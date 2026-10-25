<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;

final class SchemaExistsSqliteTest extends TestCase
{
    // Requirements: INT-57.
    public function testEscapesUnderscoreInSchemaPrefix(): void
    {
        with_case_database(
            'sqlite',
            static function (string $step): void {
            },
            static function (string $dsn, CaseDatabase $_database): void {
                $db = Orm::connect($dsn, new Config());
                try {
                    $db->pdo()->exec('CREATE TABLE "fooXbar__schema_probe" (id INTEGER)');
                    self::assertFalse($db->utils()->schema()->exists('foo_bar'));
                    self::assertTrue($db->utils()->schema()->exists('fooXbar'));
                } finally {
                    $db->close();
                }
            }
        );
    }
}
