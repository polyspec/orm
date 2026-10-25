<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

// The statement event class of the extension (KSTD-7-1, schema_install's surface): with the extension loaded,
// Polyspec\Orm\StatementEvent is an internal class of the extension, not autoloaded from the PHP library.

use PHPUnit\Framework\TestCase;

final class StatementEventSurfaceTest extends TestCase
{
    public function testExtensionProvidesStatementEvent(): void
    {
        $this->assertTrue(extension_loaded('polyspec_orm'));
        $this->assertTrue((new \ReflectionClass('Polyspec\Orm\StatementEvent'))->isInternal());
    }
}
