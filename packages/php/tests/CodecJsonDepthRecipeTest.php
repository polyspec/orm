<?php

// The recipe tests/codec/codec-json-depth.json without a database: a value nested deeper than 256 levels is refused (COD-70).
// Requirements: COD-70.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;

#[Small]
class CodecJsonDepthRecipeTest extends CodecRecipeTest
{
    protected static function recipe(): string
    {
        return 'tests/codec/codec-json-depth.json';
    }
}
