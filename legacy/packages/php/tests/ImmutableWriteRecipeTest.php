<?php

// The immutable_write recipe, contracts/fixtures/immutable_write/immutable_write.json, on each database
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: DBS-84.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;

#[Medium]
class ImmutableWriteRecipeTest extends DatabaseRecipeTestCase
{
    protected static function recipe(): string
    {
        return 'contracts/fixtures/immutable_write/immutable_write.json';
    }
}
