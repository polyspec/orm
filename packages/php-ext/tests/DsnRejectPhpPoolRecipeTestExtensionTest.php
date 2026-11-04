<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use Polyspec\Orm\Tests\DsnRejectPhpPoolRecipeTest;

// The recipe contracts/fixtures/dsn_reject/dsn_reject_php_pool.json through the PHP extension (FCV-3).
// Requirements: CFG-4, CFG-5, CFG-5b, INT-92.
#[Small]
final class DsnRejectPhpPoolRecipeTestExtensionTest extends DsnRejectPhpPoolRecipeTest
{
}
