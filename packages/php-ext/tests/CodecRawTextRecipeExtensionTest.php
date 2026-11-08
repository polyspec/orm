<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use Polyspec\Orm\Tests\CodecRawTextRecipeTest;

// The recipe tests/codec/codec-raw-text.json through the PHP extension (docs/spec/codec.md COD-70).
// Requirements: COD-64, COD-70.
#[Small]
final class CodecRawTextRecipeExtensionTest extends CodecRawTextRecipeTest
{
}
