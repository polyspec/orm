<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Db;
use Polyspec\Orm\Engine;
use Polyspec\Orm\Model;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Tests\DecimalModelDbTest;
use ReflectionClass;

require_once dirname(__DIR__, 2) . '/php/tests/DecimalModelDbTest.php';

#[Medium]
final class DecimalModelDbNativeTest extends TestCase
{
    /** @return iterable<string, array{string}> */
    public static function dialects(): iterable
    {
        foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
            yield $dialect => [$dialect];
        }
    }

    // Requirements: DIA-25, COD-2.
    #[DataProvider('dialects')]
    public function testNativeRoundTrip(string $dialect): void
    {
        foreach ([Db::class, Engine::class, Model::class, RuntimeModel::class] as $class) {
            self::assertTrue((new ReflectionClass($class))->isInternal(), "$class is the native extension class");
        }

        // The PHP generator creates the fixture model; its database execution and decimal values use the native ORM classes.
        DecimalModelDbTest::roundTrip($this, $dialect);
    }

    public static function tearDownAfterClass(): void
    {
        DecimalModelDbTest::tearDownAfterClass();
        parent::tearDownAfterClass();
    }
}
