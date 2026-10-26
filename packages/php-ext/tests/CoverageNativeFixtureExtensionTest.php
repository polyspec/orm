<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Db;
use Polyspec\Orm\Model;
use Polyspec\Orm\Planner;
use Polyspec\Orm\RuntimeModel;
use ReflectionClass;
use ReflectionMethod;
use RuntimeException;

#[Medium]
final class CoverageNativeFixtureExtensionTest extends TestCase
{
    /** @return iterable<string, array{string}> */
    public static function aggregateNumericVectors(): iterable
    {
        yield from self::vectorIds(\Polyspec\Orm\Tests\AggregateNumericTest::cases());
    }

    /** @return iterable<string, array{string}> */
    public static function decimalModelVectors(): iterable
    {
        yield from self::vectorIds(\Polyspec\Orm\Tests\DecimalModelTest::cases());
    }

    /** @return iterable<string, array{string}> */
    public static function identityLoadVectors(): iterable
    {
        yield from self::vectorIds(\Polyspec\Orm\Tests\IdentityLoadTest::cases());
    }

    /** @param iterable<array<mixed>> $cases @return iterable<string, array{string}> */
    private static function vectorIds(iterable $cases): iterable
    {
        $seen = [];
        foreach ($cases as $arguments) {
            $case = $arguments[0] ?? null;
            $id = is_array($case) ? ($case['id'] ?? null) : null;
            if (!is_string($id) || $id === '' || isset($seen[$id])) {
                throw new RuntimeException('native fixture cases must have non-empty unique IDs');
            }
            $seen[$id] = true;
            yield $id => [$id];
        }
        if ($seen === []) {
            throw new RuntimeException('native fixture has no cases');
        }
    }

    /** @param iterable<array<mixed>> $cases @return array<mixed> */
    private static function argumentsForId(iterable $cases, string $id): array
    {
        $match = null;
        foreach ($cases as $arguments) {
            $case = $arguments[0] ?? null;
            if (is_array($case) && ($case['id'] ?? null) === $id) {
                if ($match !== null) {
                    throw new RuntimeException("native fixture repeats case $id");
                }
                $match = $arguments;
            }
        }
        return $match ?? throw new RuntimeException("native fixture has no case $id");
    }

    public function testAggregateNumeric(): void
    {
        Assert::assertTrue((new ReflectionClass(Model::class))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Model::class, 'aggregateNumber'))->isInternal());
        $owner = new \Polyspec\Orm\Tests\AggregateNumericTest('testAggregateNumeric');
        foreach (\Polyspec\Orm\Tests\AggregateNumericTest::cases() as [$case]) {
            $this->assertAggregateNumericCase($owner, $case);
        }
    }

    #[DataProvider('aggregateNumericVectors')]
    public function testAggregateNumericVector(string $id): void
    {
        Assert::assertTrue((new ReflectionClass(Model::class))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Model::class, 'aggregateNumber'))->isInternal());
        [$case] = self::argumentsForId(\Polyspec\Orm\Tests\AggregateNumericTest::cases(), $id);
        $this->assertAggregateNumericCase(new \Polyspec\Orm\Tests\AggregateNumericTest('testAggregateNumeric'), $case);
    }

    /** @param array<string, mixed> $case */
    private function assertAggregateNumericCase(\Polyspec\Orm\Tests\AggregateNumericTest $owner, array $case): void
    {
        $owner->testAggregateNumeric($case);
    }

    public function testDecimalModel(): void
    {
        Assert::assertTrue((new ReflectionClass(Model::class))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Model::class, 'writeColumn'))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Model::class, 'readColumn'))->isInternal());
        $owner = new \Polyspec\Orm\Tests\DecimalModelTest('testDecimalModel');
        foreach (\Polyspec\Orm\Tests\DecimalModelTest::cases() as [$case, $column]) {
            $this->assertDecimalModelCase($owner, $case, $column);
        }
        $owner->testGeneratedDecimalType();
    }

    #[DataProvider('decimalModelVectors')]
    public function testDecimalModelVector(string $id): void
    {
        Assert::assertTrue((new ReflectionClass(Model::class))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Model::class, 'writeColumn'))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Model::class, 'readColumn'))->isInternal());
        [$case, $column] = self::argumentsForId(\Polyspec\Orm\Tests\DecimalModelTest::cases(), $id);
        $owner = new \Polyspec\Orm\Tests\DecimalModelTest('testDecimalModel');
        $this->assertDecimalModelCase($owner, $case, $column);
    }

    /** @param array<string, mixed> $case @param array<string, mixed> $column */
    private function assertDecimalModelCase(
        \Polyspec\Orm\Tests\DecimalModelTest $owner,
        array $case,
        array $column
    ): void {
        $owner->testDecimalModel($case, $column);
        CoverageNativeDecimalModel::$precision = $column['precision'];
        CoverageNativeDecimalModel::$scale = $column['scale'];
        $model = new CoverageNativeDecimalModel();
        if (isset($case['expected']['error'])) {
            try {
                $model->setAmount($case['input']);
                self::fail("{$case['id']}: native model accepted an invalid decimal");
            } catch (\Polyspec\Orm\OrmException $error) {
                Assert::assertSame($case['expected']['error'], $error->code_, "{$case['id']}: native setter error");
            }
            return;
        }
        $model->setAmount($case['input']);
        Assert::assertSame($case['expected']['value'], $model->getAmount(), "{$case['id']}: native model value");
    }

    // Requirements: INT-76.
    public function testIdentityLoad(): void
    {
        $this->assertNativeIdentityLoadEntryPoints();
        $owner = new \Polyspec\Orm\Tests\IdentityLoadTest('testIdentityLoad');
        foreach (\Polyspec\Orm\Tests\IdentityLoadTest::cases() as [$case]) {
            $this->assertIdentityLoadCase($owner, $case);
        }
    }

    #[DataProvider('identityLoadVectors')]
    public function testIdentityLoadVector(string $id): void
    {
        $this->assertNativeIdentityLoadEntryPoints();
        [$case] = self::argumentsForId(\Polyspec\Orm\Tests\IdentityLoadTest::cases(), $id);
        $this->assertIdentityLoadCase(new \Polyspec\Orm\Tests\IdentityLoadTest('testIdentityLoad'), $case);
    }

    /** @param array<string, mixed> $case */
    private function assertIdentityLoadCase(\Polyspec\Orm\Tests\IdentityLoadTest $owner, array $case): void
    {
        if ($case['operation'] === 'compile') {
            $this->assertIdentityLoadCompileCase($case);
            return;
        }
        $owner->testIdentityLoad($case);
    }

    public function testIdentityLoadCompileCases(): void
    {
        $this->assertNativeIdentityLoadEntryPoints();
        foreach (\Polyspec\Orm\Tests\IdentityLoadTest::cases() as [$case]) {
            if ($case['operation'] === 'compile') {
                $this->assertIdentityLoadCompileCase($case);
            }
        }
    }

    /** @param array<string, mixed> $case */
    private function assertIdentityLoadCompileCase(array $case): void
    {
        $root = dirname(__DIR__, 3);
        $doc = json_decode(
            (string) file_get_contents("$root/contracts/fixtures/identity_load.json"),
            true,
            512,
            JSON_THROW_ON_ERROR
        );
        $fixture = (string) file_get_contents("$root/{$doc['fixture']}");
        $model = RuntimeModel::build(RuntimeModel::parse([basename($doc['fixture']) => $fixture]));
        foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
            if (isset($case['expected']['error'])) {
                \Polyspec\Orm\Tests\expect_error(
                    static fn() => \Polyspec\Orm\Tests\compile_load($model, $dialect, $case['input']),
                    $case['expected']['error'],
                    $case['expected']['message'],
                    "$dialect: compile"
                );
                continue;
            }
            $plan = \Polyspec\Orm\Tests\compile_load($model, $dialect, $case['input']);
            $got = array_map('\\Polyspec\\Orm\\Tests\\load_statement', $plan['steps']);
            $want = array_map('\\Polyspec\\Orm\\Tests\\expected_statement', $case['expected'][$dialect] ?? []);
            Assert::assertNotSame([], $want, "$dialect: the case states no statements");
            Assert::assertSame($want, $got, "$dialect statements");
        }
    }

    private function assertNativeIdentityLoadEntryPoints(): void
    {
        Assert::assertTrue((new ReflectionClass(RuntimeModel::class))->isInternal());
        Assert::assertTrue((new ReflectionClass(Planner::class))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Planner::class, 'compile'))->isInternal());
        Assert::assertTrue((new ReflectionClass(Db::class))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Db::class, 'execute'))->isInternal());
    }
}
