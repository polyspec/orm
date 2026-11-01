<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use Polyspec\Orm\Tests\CodecOrderedJsonTextTest;

// A text that is not Unicode through the codec of the PHP extension (docs/spec/codec.md COD-64).
// Requirements: COD-64.
#[Small]
final class CodecOrderedJsonTextExtensionTest extends CodecOrderedJsonTextTest
{
}
