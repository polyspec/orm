<?php

// Requirements: INT-103

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\CatalogConnectionSqliteOnlyRecipeTest;

// The catalog connection sqlite-only recipe through the PHP extension (docs/spec/feature-coverage.md FCV-3).
#[Medium]
final class CatalogConnectionSqliteOnlyRecipeTestExtensionTest extends CatalogConnectionSqliteOnlyRecipeTest
{
}
