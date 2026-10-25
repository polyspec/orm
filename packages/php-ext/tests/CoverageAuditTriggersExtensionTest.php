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

    // The audit history case of the PHP library, run with the extension loaded.
    // Requirements: CFG-8, DBS-87, DBS-88, DBS-89, DBS-93, DBS-117, DSL-118, DSL-126.
    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- the parity binding names this exact test symbol.
    public function test_audit_history(): void
    {
        parent::test_audit_history();
    }

    // The audit transaction entry point case of the PHP library, run with the extension loaded.
    // Requirements: CFG-8, DBS-87, DBS-88, DBS-93, DSL-126.
    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- the parity binding names this exact test symbol.
    public function test_audit_transaction_entry_points(): void
    {
        parent::test_audit_transaction_entry_points();
    }

    // The soft delete and restore case of the PHP library, run with the extension loaded.
    // Requirements: DBS-67, DBS-87, DBS-88, DBS-93, DBS-96, DBS-117, DIA-161, INT-38.
    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- the parity binding names this exact test symbol.
    public function test_soft_delete_restore(): void
    {
        parent::test_soft_delete_restore();
    }
}
