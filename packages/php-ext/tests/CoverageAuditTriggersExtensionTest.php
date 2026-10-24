<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// Requirements: INT-44.

use PHPUnit\Framework\Attributes\Medium;

#[Medium]
final class CoverageAuditTriggersExtensionTest extends CoverageAuditTriggersTest
{
    use NativeMethodAssertions;

    protected static function coverageTestFile(): string
    {
        return __FILE__;
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- the owner target filters this exact test symbol.
    public function test_native_methods_are_internal(): void
    {
        $this->assertAuditMethodsAreInternal();
    }
}
