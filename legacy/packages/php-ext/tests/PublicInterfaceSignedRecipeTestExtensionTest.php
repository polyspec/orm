<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use Polyspec\Orm\Tests\PublicInterfaceSignedRecipeTest;

// The signed public interface recipe, contracts/fixtures/public_interface/public_interface_signed.json (the signed
// limit, which Rust refuses at compile time), through the PHP extension (FCV-3).
// Requirements: INT-159.
#[Small]
final class PublicInterfaceSignedRecipeTestExtensionTest extends PublicInterfaceSignedRecipeTest
{
}
