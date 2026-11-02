<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Tests\CoverageSchemaDefinitionTest;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Small;

// Requirements: DBS-136, DBS-144.
#[Small]
final class CoverageSchemaDefinitionExtensionTest extends CoverageSchemaDefinitionTest
{
    protected static function dbspec(): string
    {
        Assert::assertTrue((new \ReflectionClass(Dbspec::class))->isInternal());
        return Dbspec::class;
    }
}
