<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use Polyspec\Orm\Tests\CodecErrorCauseTest;

// The error chain of the codec through the PHP extension (docs/spec/codec.md COD-33, COD-35).
#[Small]
final class CodecErrorCauseTestExtensionTest extends CodecErrorCauseTest
{
}
