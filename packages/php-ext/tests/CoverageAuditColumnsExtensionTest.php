<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;

#[Medium]
final class CoverageAuditColumnsExtensionTest extends CoverageAuditColumnsTest
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
