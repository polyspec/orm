<?php

// Requirements: DBS-115, DIA-11, DIA-14, DIA-24, DIA-37, DSL-54, DSL-99, DSL-137, DSL-139, DSL-144, INT-39, PRT-77.
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
