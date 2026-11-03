<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Tests\ImmutableWriteRecipeTest;

// The immutable_write recipe through the PHP extension (docs/spec/feature-coverage.md FCV-3).
// Requirements: DBS-84.
#[Medium]
final class ImmutableWriteRecipeTestExtensionTest extends ImmutableWriteRecipeTest
{
}
