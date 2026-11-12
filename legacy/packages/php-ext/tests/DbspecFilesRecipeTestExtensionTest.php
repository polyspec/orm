<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use Polyspec\Orm\Tests\DbspecFilesRecipeTest;

// The files recipe, tests/dbspec/files.json, through the PHP extension (docs/spec/feature-coverage.md FCV-4).
// Requirements: DBS-4, DBS-155, DBS-171.
#[Small]
final class DbspecFilesRecipeTestExtensionTest extends DbspecFilesRecipeTest
{
}
