<?php

// The recipe tests/codec/codec-non-finite-value.json without a database: a float that is not finite is refused
// (COD-70).
// Requirements: COD-70.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;

#[Small]
class CodecNonFiniteValueRecipeTest extends CodecRecipeTest
{
    protected static function recipe(): string
    {
        return 'tests/codec/codec-non-finite-value.json';
    }
}
