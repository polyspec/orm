<?php

// Requirements: DSL-54, DSL-99, DSL-137, DSL-139, DSL-144, DIA-11, DIA-14, PRT-77, DIA-24, DIA-18, DIA-56.
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
