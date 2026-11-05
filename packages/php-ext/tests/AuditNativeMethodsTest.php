<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// The audit calls of the recipe audit_triggers run in the classes of the extension. This test stays native (FCV-2):
// only the PHP extension has internal classes, so no recipe of another runtime holds this behaviour.
// Requirements: INT-44b.

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
final class AuditNativeMethodsTest extends TestCase
{
    use NativeMethodAssertions;

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- the owner target filters this exact test symbol.
    public function testNativeMethodsAreInternal(): void
    {
        $this->assertAuditMethodsAreInternal();
    }
}
