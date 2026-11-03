<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\DbspecApplyRecipeTest;

// The dbspec_apply recipe through the PHP extension (docs/spec/feature-coverage.md FCV-3).
// Requirements: PLN-89, PLN-90, PLN-91, PLN-92, PLN-93, PLN-94, PLN-95, PLN-96, PLN-104, PLN-105.
#[Medium]
final class DbspecApplyRecipeTestExtensionTest extends DbspecApplyRecipeTest
{
}
