<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use Polyspec\Orm\Tests\DsnRejectParametersRecipeTest;

// The recipe contracts/fixtures/dsn_reject/dsn_reject_parameters.json through the PHP extension (FCV-3).
// Requirements: CFG-19, CFG-20, CFG-35.
#[Small]
final class DsnRejectParametersRecipeTestExtensionTest extends DsnRejectParametersRecipeTest
{
}
