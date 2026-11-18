<?php

declare(strict_types=1);

// Requirements: FCV-4, FCV-9, FCV-10, DSL-32, DSL-33, DIA-6, PRT-75.

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\FulltextSearchRecipeTest;

// The full-text search recipe through the PHP extension (docs/spec/feature-coverage.md FCV-22).
#[Medium]
final class FulltextSearchRecipeTestExtensionTest extends FulltextSearchRecipeTest
{
}
