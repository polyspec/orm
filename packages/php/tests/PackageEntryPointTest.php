<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\PreserveGlobalState;
use PHPUnit\Framework\Attributes\RunInSeparateProcess;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
final class PackageEntryPointTest extends TestCase
{
    // Requirements: INT-138, PRT-46, PRT-51, PRT-56, PRT-61.
    #[RunInSeparateProcess]
    #[PreserveGlobalState(false)]
    public function testTestingFaultsRequireTheirExplicitPackagePath(): void
    {
        self::assertTrue(
            class_exists(\Polyspec\Orm\Db::class),
            'the Composer package autoloader cannot resolve the public Db entry point'
        );
        $class = 'Polyspec\\Orm\\Testing\\Faults';
        self::assertFalse(
            class_exists($class),
            'the production package autoloader resolves the test-only Faults class'
        );

        $entryPoint = dirname(__DIR__) . '/testing/Faults.php';
        self::assertFileExists($entryPoint, 'the distribution omits the declared test entry point');
        require_once $entryPoint;

        self::assertTrue(class_exists($class, false));
        foreach (['failNextRollback', 'failNextStatement', 'fixClock', 'lastAffected'] as $method) {
            self::assertTrue(method_exists($class, $method), "the explicit test entry point has no {$method} method");
        }
    }
}
