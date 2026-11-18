<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use Polyspec\Orm\Tests\DsnRejectRecipeTest;

// The refused DSN recipe, contracts/fixtures/dsn_reject/dsn_reject.json, through the PHP extension (FCV-22).
// Requirements: CFG-2, CFG-17, CFG-19, CFG-26, FCV-23, PRT-64.
#[Small]
final class DsnRejectRecipeTestExtensionTest extends DsnRejectRecipeTest
{
}
