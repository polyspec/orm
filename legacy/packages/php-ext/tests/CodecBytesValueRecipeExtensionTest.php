<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use Polyspec\Orm\Tests\CodecBytesValueRecipeTest;

// The recipe tests/codec/codec-bytes-value.json through the PHP extension (docs/spec/codec.md COD-63).
// Requirements: COD-63.
#[Small]
final class CodecBytesValueRecipeExtensionTest extends CodecBytesValueRecipeTest
{
}
