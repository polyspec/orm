<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use Polyspec\Orm\Tests\CodecNonFiniteValueRecipeTest;

// The recipe tests/codec/codec-non-finite-value.json through the PHP extension (docs/spec/codec.md COD-70).
// Requirements: COD-70.
#[Small]
final class CodecNonFiniteValueRecipeExtensionTest extends CodecNonFiniteValueRecipeTest
{
}
