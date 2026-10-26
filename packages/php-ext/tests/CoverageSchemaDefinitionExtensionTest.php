<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Dbspec\Dbspec;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Small;

// Requirements: DBS-123.
// Requirements: DBS-103.
// Requirements: DBS-99.
// Requirements: DBS-134, DBS-135.
// Requirements: DBS-141.
// Requirements: DBS-141, ORES-14.
// Requirements: DBS-142.
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
