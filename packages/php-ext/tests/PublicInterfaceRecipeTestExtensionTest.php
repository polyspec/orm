<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Large;
use Polyspec\Orm\Tests\PublicInterfaceRecipeTest;

// The public interface recipe, contracts/fixtures/public_interface/public_interface.json, through the PHP extension
// (FCV-3).
// Requirements: INT-17, INT-18, INT-19, INT-57, INT-61, INT-64, INT-74, INT-88, INT-89, INT-130.
#[Large]
final class PublicInterfaceRecipeTestExtensionTest extends PublicInterfaceRecipeTest
{
}
