<?php

// The utils recipe, contracts/fixtures/utils/utils.json, on each database (docs/spec/feature-coverage.md FCV-3).
// Requirements: INT-51, INT-52, INT-53, INT-61, INT-73, INT-134, CFG-30, INT-50, INT-72, INT-79, CFG-4.

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;

#[Medium]
class UtilsRecipeTest extends DatabaseRecipeTestCase
{
    protected static function recipe(): string
    {
        return 'contracts/fixtures/utils/utils.json';
    }
}
