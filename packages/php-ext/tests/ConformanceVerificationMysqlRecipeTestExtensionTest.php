<?php

// Requirements: PRT-77.
declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\ConformanceVerificationMysqlRecipeTest;

// The conformance_verification recipe on mysql through the PHP extension
// (docs/spec/feature-coverage.md FCV-3 and FCV-4).
#[Medium]
final class ConformanceVerificationMysqlRecipeTestExtensionTest extends ConformanceVerificationMysqlRecipeTest
{
}
