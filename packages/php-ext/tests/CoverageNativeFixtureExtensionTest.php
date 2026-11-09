<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Model;
use ReflectionClass;
use ReflectionMethod;

#[Medium]
final class CoverageNativeFixtureExtensionTest extends TestCase
{
    /** @return iterable<string, array{string}> */
    public static function aggregateNumericVectors(): iterable
    {
        return self::nativeFixtureIds(\Polyspec\Orm\Tests\AggregateNumericTest::cases());
    }

    /** @param iterable<array<mixed>> $cases @return iterable<string, array{string}> */
    private static function nativeFixtureIds(iterable $cases): iterable
    {
        return \Polyspec\Orm\Tests\NativeFixtureVectors::ids($cases, 'native');
    }

    #[DataProvider('aggregateNumericVectors')]
    public function testAggregateNumericVector(string $id): void
    {
        Assert::assertTrue((new ReflectionClass(Model::class))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Model::class, 'aggregateNumber'))->isInternal());
        [$case] = \Polyspec\Orm\Tests\NativeFixtureVectors::argumentsForId(
            \Polyspec\Orm\Tests\AggregateNumericTest::cases(),
            $id,
            'native'
        );
        $this->assertAggregateNumericCase(new \Polyspec\Orm\Tests\AggregateNumericTest('testAggregateNumeric'), $case);
    }

    /** @param array<string, mixed> $case */
    private function assertAggregateNumericCase(\Polyspec\Orm\Tests\AggregateNumericTest $owner, array $case): void
    {
        $owner->testAggregateNumeric($case);
    }
}
