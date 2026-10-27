<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Tests\OrmGenScanTest;

// Requirements: DBS-173, DSL-151, DSL-37, DSL-38, DSL-44.
#[\PHPUnit\Framework\Attributes\Small]
final class OrmGenScanTestExtensionTest extends OrmGenScanTest
{
    private static string $previousWorkingDirectory;

    public static function setUpBeforeClass(): void
    {
        parent::setUpBeforeClass();
        self::$previousWorkingDirectory = getcwd() ?: throw new \RuntimeException('cannot read current directory');
        if (!chdir(dirname(__DIR__, 3))) {
            throw new \RuntimeException('cannot set the repository as the test working directory');
        }
    }

    public static function tearDownAfterClass(): void
    {
        try {
            parent::tearDownAfterClass();
        } finally {
            if (!chdir(self::$previousWorkingDirectory)) {
                throw new \RuntimeException('cannot restore the PHP-extension test working directory');
            }
        }
    }
}
