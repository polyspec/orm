<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Tests\DecimalModelDbTest;
use Polyspec\Orm\Tests\NativeMethodAssertions;
use Polyspec\Orm\Tests\ThreeDrivers;

#[Medium]
final class DecimalModelDbNativeTest extends TestCase
{
    use NativeMethodAssertions;
    use ThreeDrivers;

    // Requirements: DIA-25, COD-2.
    #[DataProvider('drivers')]
    public function testNativeRoundTrip(string $dialect): void
    {
        self::assertNativeDecimalClasses();

        // The PHP generator creates the fixture model; its database execution and decimal values use the native ORM
        // classes.
        DecimalModelDbTest::roundTrip($this, $dialect);
    }

    public static function tearDownAfterClass(): void
    {
        DecimalModelDbTest::tearDownAfterClass();
        parent::tearDownAfterClass();
    }
}
