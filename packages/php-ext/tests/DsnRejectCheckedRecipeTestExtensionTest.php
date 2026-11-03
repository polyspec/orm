<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use Polyspec\Orm\Tests\DsnRejectCheckedRecipeTest;

// The recipe contracts/fixtures/dsn_reject/dsn_reject_checked.json through the PHP extension (FCV-3).
// Requirements: CFG-4, CFG-5, CFG-6, CFG-18, CFG-34.
#[Small]
final class DsnRejectCheckedRecipeTestExtensionTest extends DsnRejectCheckedRecipeTest
{
}
