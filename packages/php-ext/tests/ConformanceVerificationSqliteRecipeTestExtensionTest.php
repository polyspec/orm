<?php

// Requirements: PRT-77, DSL-10, DSL-19, DSL-47, DSL-67, DSL-96, DSL-98, DSL-123, PRT-14.
declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\ConformanceVerificationSqliteRecipeTest;

// The conformance_verification recipe on sqlite through the PHP extension
// (docs/spec/feature-coverage.md FCV-3 and FCV-4).
#[Medium]
final class ConformanceVerificationSqliteRecipeTestExtensionTest extends ConformanceVerificationSqliteRecipeTest
{
}
