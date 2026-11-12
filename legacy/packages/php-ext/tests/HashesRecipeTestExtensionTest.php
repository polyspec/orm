<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use Polyspec\Orm\Tests\HashesRecipeTest;

// The dbspec manifest hash recipe, tests/dbspec/hashes.json, through the PHP extension (docs/spec/feature-coverage.md
// FCV-4).
// Requirements: DBS-65, ORES-16, DBS-86, DBS-94, DBS-99, DBS-100, DBS-102, DBS-103, DIA-97.
// Requirements: ORES-13.
#[Small]
final class HashesRecipeTestExtensionTest extends HashesRecipeTest
{
}
