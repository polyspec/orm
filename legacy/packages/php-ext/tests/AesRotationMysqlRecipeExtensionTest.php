<?php

// Requirements: COD-7, COD-8, PLN-44, INT-60, INT-75, INT-131.
// Recipe conversion of the AES rotation: FCV-3 and FCV-4 (docs/spec/feature-coverage.md), suite unit
// aes_rotation-mysql.

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\AesRotationMysqlTest;

// The AES rotation recipe on mysql through the PHP extension (docs/spec/feature-coverage.md FCV-3 and FCV-4).
#[Medium]
final class AesRotationMysqlRecipeExtensionTest extends AesRotationMysqlTest
{
}
