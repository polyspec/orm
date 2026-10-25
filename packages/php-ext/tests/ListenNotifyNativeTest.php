<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

// Requirements: DIA-192, DIA-193, DIA-194, DIA-195, DIA-196, PRT-74.

use Polyspec\Orm\Db;
use Polyspec\Orm\Subscription;
use Polyspec\Orm\Tests\ListenNotifyCases;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use ReflectionMethod;

#[Medium]
final class ListenNotifyNativeTest extends TestCase
{
    use ListenNotifyCases;

    public function testListenNotifyNative(): void
    {
        self::assertTrue((new ReflectionMethod(Db::class, 'listen'))->isInternal());
        self::assertTrue((new ReflectionMethod(Subscription::class, 'receive'))->isInternal());
        $this->runListenNotifyCases();
    }
}
