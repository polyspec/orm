<?php

// Requirements: PRT-67, INT-150.
declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\RawTextRecipeTest;

// The recipe of a text that is not UTF-8 through the PHP extension (docs/spec/feature-coverage.md FCV-3).
#[Medium]
final class RawTextRecipeTestExtensionTest extends RawTextRecipeTest
{
}
