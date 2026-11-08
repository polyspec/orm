<?php

// The recipe tests/codec/codec-raw-text.json without a database: a string whose bytes are not UTF-8 is refused (COD-64, COD-70).
// Requirements: COD-64, COD-70.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;

#[Small]
class CodecRawTextRecipeTest extends CodecRecipeTest
{
    protected static function recipe(): string
    {
        return 'tests/codec/codec-raw-text.json';
    }
}
