<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;

// The rendered statements of tests/dbspec/ddl.json and their behavior steps on each database
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: DIA-113, FCV-3, FCV-4 (docs/spec/feature-coverage.md).
#[Medium]
class DbspecRenderPhysicalRecipeTest extends DatabaseRecipeTestCase
{
    protected static function recipe(): string
    {
        return 'tests/dbspec/render-physical.json';
    }
}
