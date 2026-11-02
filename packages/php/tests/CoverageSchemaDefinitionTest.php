<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// schema_definition feature coverage that is not a case of tests/dbspec/schema-definition.json: the cases of that
// recipe run in SchemaDefinitionRecipeTest (and its extension twin), without a database. The dbspec implementation of
// this class is Polyspec\Orm\Dbspec\Dbspec, and the extension twin, CoverageSchemaDefinitionExtensionTest, runs the
// same test on the PHP extension polyspec_orm, loaded in its own process (make dbspec-php-extension-check).

use Polyspec\Orm\Dbspec\Dbspec;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
class CoverageSchemaDefinitionTest extends TestCase
{
    /** The dbspec implementation the cases run on: the PHP client here, the extension in its subclass. */
    protected static function dbspec(): string
    {
        return Dbspec::class;
    }

    // Requirements: DBS-136, DBS-144.
    public function testDbspecLimitStopHasNoTokens(): void
    {
        $dbspec = static::dbspec();
        $lines = [];
        for ($i = 1; $i <= 4097; $i++) {
            $lines[] = "table t$i {";
            $lines[] = '}';
        }
        $text = "dbspec 1 d\n" . implode("\n", $lines) . "\n";
        $analysis = $dbspec::analyze($text, ['d' => $text]);
        Assert::assertSame([], $analysis->tokens);
        Assert::assertNull($analysis->document);
        Assert::assertNotSame([], $analysis->diagnostics);
        Assert::assertSame('limit', $analysis->diagnostics[array_key_last($analysis->diagnostics)]->rule);
    }
}
