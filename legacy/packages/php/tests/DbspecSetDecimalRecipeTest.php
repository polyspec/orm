<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;

// The decimal document set on each database (docs/spec/feature-coverage.md FCV-22).
// Requirements: DBS-108, SCH-7, FCV-22, FCV-4 (docs/spec/feature-coverage.md).
#[Medium]
class DbspecSetDecimalRecipeTest extends DatabaseRecipeTestCase
{
    protected static function recipe(): string
    {
        return 'tests/dbspec/set-decimal.json';
    }
}
