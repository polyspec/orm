<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\ConformanceVerificationDynamicRecipeTest;

// The conformance_verification recipe of the runtimes that type no value at compile time, through the PHP extension
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: PRT-67.
#[Medium]
final class ConformanceVerificationDynamicRecipeTestExtensionTest extends ConformanceVerificationDynamicRecipeTest
{
}
