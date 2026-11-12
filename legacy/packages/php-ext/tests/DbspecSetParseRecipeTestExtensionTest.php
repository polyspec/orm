<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use Polyspec\Orm\Tests\DbspecSetParseRecipeTest;

// The set-parse recipe, tests/dbspec/set-parse.json, through the PHP extension (docs/spec/feature-coverage.md FCV-4).
// Requirements: DBS-2, DBS-28, DBS-29, DBS-30, DBS-31, DBS-156, DBS-168, DBS-171.
#[Small]
final class DbspecSetParseRecipeTestExtensionTest extends DbspecSetParseRecipeTest
{
}
