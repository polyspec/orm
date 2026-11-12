<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
final class MermaidErrorBoundaryTest extends TestCase
{
    public function testCatalogBuildFailureBecomesDiagnostic(): void
    {
        self::assertTrue(function_exists('mermaid_test_import'), 'the test-only extension module is loaded');
        $result = mermaid_test_import(1);
        self::assertFalse($result['document']);
        self::assertSame(1, $result['diagnostics']);
    }

    public function testUnexpectedNativeCatalogErrorKeepsIdentity(): void
    {
        $cause = new \RuntimeException('unexpected native catalog failure');
        try {
            mermaid_test_import(2, $cause);
            self::fail('an unexpected native catalog error was swallowed');
        } catch (\RuntimeException $error) {
            self::assertSame($cause, $error);
        }
    }
}
