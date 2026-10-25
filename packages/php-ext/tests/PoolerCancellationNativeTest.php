<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Cancellation;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use ReflectionMethod;

// Requirements: CFG-31.
#[Medium]
final class PoolerCancellationNativeTest extends TestCase
{
    use \Polyspec\Orm\Tests\PoolerCancellationCase;

    public function testNativePgBouncerForwardsCancellationAndRootRemainsUsable(): void
    {
        self::assertTrue((new ReflectionMethod(Orm::class, 'connect'))->isInternal());
        self::assertTrue((new ReflectionMethod(Db::class, 'withCancellation'))->isInternal());
        $this->assertPgBouncerForwardsCancellationAndRootRemainsUsable();
    }
}
