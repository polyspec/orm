<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use Polyspec\Orm\Tests\PublicInterfaceRecipeTest;

// The public interface recipe, contracts/fixtures/public_interface/public_interface.json, through the PHP extension (FCV-3).
// Requirements: INT-74, INT-88, INT-89, INT-130.
#[Small]
final class PublicInterfaceRecipeTestExtensionTest extends PublicInterfaceRecipeTest
{
}
