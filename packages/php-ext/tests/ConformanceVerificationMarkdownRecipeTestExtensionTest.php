<?php

// Requirements: DBS-115, DIA-11, DIA-14, DIA-18, DIA-24, DIA-37, DIA-56, DSL-54, DSL-99, DSL-137, DSL-139, DSL-144,
// Requirements: INT-39, PRT-77, DSL-10, DSL-19, DSL-47, DSL-67, DSL-96, DSL-98, DSL-123, PRT-14.
declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\ConformanceVerificationMarkdownRecipeTest;

// The conformance_verification recipe on markdown through the PHP extension
// (docs/spec/feature-coverage.md FCV-3 and FCV-4).
#[Medium]
final class ConformanceVerificationMarkdownRecipeTestExtensionTest extends ConformanceVerificationMarkdownRecipeTest
{
}
