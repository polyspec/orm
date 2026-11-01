<?php

// The recipe tests/codec/codec-bytes-value.json without a database: bytes are not a codec value (COD-63).
// Requirements: COD-63.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;

#[Small]
class CodecBytesValueRecipeTest extends CodecRecipeTest
{
    protected static function recipe(): string
    {
        return 'tests/codec/codec-bytes-value.json';
    }
}
