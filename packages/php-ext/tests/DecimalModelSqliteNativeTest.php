<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Tests\DecimalModelDbTest;
use Polyspec\Orm\Tests\NativeMethodAssertions;

final class DecimalModelSqliteNativeTest extends TestCase
{
    use NativeMethodAssertions;

    // Requirements: DIA-25, COD-2.
    public function testNativeSqliteRoundTrip(): void
    {
        self::assertNativeDecimalClasses();
        DecimalModelDbTest::roundTripSqlite($this);
    }
}
