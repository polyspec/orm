<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Orm;
use ReflectionMethod;

require_once dirname(__DIR__, 2) . '/php/tests/CoverageDsnTest.php';

#[Medium]
final class CoverageDsnConnectionExtensionTest extends CoverageDsnTest
{
    protected static function coverageTestFile(): string
    {
        return __FILE__;
    }

    public function test_native_methods_are_internal(): void
    {
        Assert::assertTrue((new ReflectionMethod(Orm::class, 'parseDsn'))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Orm::class, 'connect'))->isInternal());
    }
}
