<?php

// Requirements: COD-8, PLN-44, INT-60, INT-75, INT-131.
// Recipe conversion of the AES rotation: FCV-3 and FCV-4 (docs/spec/feature-coverage.md), suite unit
// INT-152: on SQLite a text stored in an INTEGER or REAL column is a text grid cell; the recipe expects it
// at step 16 of read_path_codes, rotation_path_codes and stored_version_text. Requirement: INT-152.
// aes_rotation-sqlite.

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\AesRotationSqliteTest;

// The AES rotation recipe on sqlite through the PHP extension (docs/spec/feature-coverage.md FCV-3 and FCV-4).
#[Medium]
final class AesRotationSqliteRecipeExtensionTest extends AesRotationSqliteTest
{
}
