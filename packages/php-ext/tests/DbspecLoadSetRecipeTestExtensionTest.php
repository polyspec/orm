<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Tests\DbspecLoadSetRecipeTest;

// The load of a document set, tests/dbspec/load-set.json, through the PHP extension
// (docs/spec/feature-coverage.md FCV-3, FCV-4). Requirements: SCH-12, DBS-156, DBS-100, DBS-103.
#[\PHPUnit\Framework\Attributes\Medium]
final class DbspecLoadSetRecipeTestExtensionTest extends DbspecLoadSetRecipeTest
{
}
