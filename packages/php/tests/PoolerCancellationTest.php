<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Cancellation;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

// Requirements: CFG-31.
#[Medium]
final class PoolerCancellationTest extends TestCase
{
    use PoolerCancellationCase;

    public function testPgBouncerForwardsCancellationAndRootRemainsUsable(): void
    {
        $this->assertPgBouncerForwardsCancellationAndRootRemainsUsable();
    }
}
