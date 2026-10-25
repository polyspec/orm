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

    // The selected audit column case of the PHP library, run with the extension loaded.
    // Requirements: DBS-85, DBS-88, DBS-93, DBS-94, DBS-96.
    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- the parity binding names this exact test symbol.
    public function test_audit_selected_columns(): void
    {
        parent::test_audit_selected_columns();
    }
}
