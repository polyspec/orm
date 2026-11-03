<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\Dbspec;

// The release extension holds the Dbspec class and omits the private test hooks.
#[Small]
final class DbspecReleaseHooksTest extends TestCase
{
    // Requirements: PRT-18.
    public function testReleaseExtensionOmitsPrivateHooks(): void
    {
        self::assertTrue(extension_loaded('polyspec_orm'));
        Assert::assertTrue((new \ReflectionClass(Dbspec::class))->isInternal());
        self::assertFalse(function_exists('mermaid_test_import'), 'release extension omits private Mermaid test hooks');
    }
}
