<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\ComplexQueryPostgresRecipeTest;

// The complex_query recipe on postgres through the PHP extension
// (docs/spec/feature-coverage.md FCV-3 and FCV-4).
#[Medium]
final class ComplexQueryPostgresRecipeTestExtensionTest extends ComplexQueryPostgresRecipeTest
{
}
