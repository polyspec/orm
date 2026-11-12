<?php

// The schema installation recipe, contracts/fixtures/schema_install/schema_install.json, on each database
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: SCH-13.
// Requirements: FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14, DBS-104, DBS-107, DBS-108, DBS-119,
// DBS-120, INT-54, INT-55, INT-132, INT-133, PLN-44, SCH-7, SCH-10, SCH-11.

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\SchemaInstallRecipeTest;

// The schema installation recipe through the PHP extension (docs/spec/feature-coverage.md FCV-3).
// Requirements: DBS-104, DBS-107, DBS-108, DBS-119, DBS-120, INT-54, INT-55, INT-132, INT-133, PLN-44, SCH-7, SCH-10,
// SCH-11.
#[Medium]
final class SchemaInstallRecipeTestExtensionTest extends SchemaInstallRecipeTest
{
}
