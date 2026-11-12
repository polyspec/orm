<?php

// The conformance_verification recipe of the runtimes that type no value at compile time,
// contracts/fixtures/conformance_verification/conformance_verification_dynamic.json, on each database
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: PRT-67.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;

#[Medium]
class ConformanceVerificationDynamicRecipeTest extends DatabaseRecipeTestCase
{
    protected static function recipe(): string
    {
        return 'contracts/fixtures/conformance_verification/conformance_verification_dynamic.json';
    }
}
