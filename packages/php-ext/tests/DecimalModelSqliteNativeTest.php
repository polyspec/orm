<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Db;
use Polyspec\Orm\Engine;
use Polyspec\Orm\Model;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Tests\DecimalModelDbTest;
use ReflectionClass;

final class DecimalModelSqliteNativeTest extends TestCase
{
    // Requirements: DIA-25, COD-2.
    public function testNativeSqliteRoundTrip(): void
    {
        foreach ([Db::class, Engine::class, Model::class, RuntimeModel::class] as $class) {
            self::assertTrue((new ReflectionClass($class))->isInternal(), "$class is the native extension class");
        }
        DecimalModelDbTest::roundTripSqlite($this);
    }
}
