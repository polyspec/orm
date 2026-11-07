<?php

// Requirements: PRT-67, INT-150.
// The recipe of a text that is not UTF-8, contracts/fixtures/raw_text/raw_text.json, on each database
// (docs/spec/feature-coverage.md FCV-3): a PHP string holds any bytes.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;

#[Medium]
class RawTextRecipeTest extends DatabaseRecipeTestCase
{
    protected static function recipe(): string
    {
        return 'contracts/fixtures/raw_text/raw_text.json';
    }
}
