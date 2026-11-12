<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use Polyspec\Orm\Tests\SchemaDefinitionRecipeTest;

// The schema definition recipe, tests/dbspec/schema-definition.json, through the PHP extension
// (docs/spec/feature-coverage.md FCV-4).
// Requirements: DBS-1, DBS-99, DBS-103, DBS-123, DBS-134, DBS-135, DBS-141, DBS-142, ORES-14.
#[Small]
final class SchemaDefinitionRecipeTestExtensionTest extends SchemaDefinitionRecipeTest
{
}
