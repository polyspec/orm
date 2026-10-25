<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Dbspec\Dbspec;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Small;

#[Small]
final class CoverageSchemaDefinitionExtensionTest extends CoverageSchemaDefinitionTest
{
    protected static function dbspec(): string
    {
        Assert::assertTrue((new \ReflectionClass(Dbspec::class))->isInternal());
        return Dbspec::class;
    }
}
