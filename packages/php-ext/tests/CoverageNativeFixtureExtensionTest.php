<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Db;
use Polyspec\Orm\Model;
use Polyspec\Orm\Planner;
use Polyspec\Orm\RuntimeModel;
use ReflectionClass;
use ReflectionMethod;

require_once dirname(__DIR__, 2) . '/php/tests/AggregateNumericTest.php';
require_once dirname(__DIR__, 2) . '/php/tests/DecimalModelTest.php';
require_once dirname(__DIR__, 2) . '/php/tests/IdentityLoadTest.php';

final class CoverageNativeDecimalModel extends Model
{
    public static int $precision = 1;
    public static int $scale = 0;

    public static function meta(): array
    {
        return [
            'entity' => 'coverage_native_decimal',
            'columns' => [
                'amount' => [
                    'type' => 'decimal',
                    'precision' => self::$precision,
                    'scale' => self::$scale,
                    'codec' => [],
                    'nullable' => true,
                ],
            ],
        ];
    }

    public function setAmount(mixed $value): static
    {
        return $this->writeColumn('amount', $value);
    }

    public function getAmount(): mixed
    {
        return $this->readColumn('amount');
    }
}

#[Medium]
final class CoverageNativeFixtureExtensionTest extends TestCase
{
    public function testAggregateNumeric(): void
    {
        Assert::assertTrue((new ReflectionClass(Model::class))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Model::class, 'aggregateNumber'))->isInternal());
        $owner = new \Polyspec\Orm\Tests\AggregateNumericTest('testAggregateNumeric');
        foreach (\Polyspec\Orm\Tests\AggregateNumericTest::cases() as [$case]) {
            $owner->testAggregateNumeric($case);
        }
    }

    public function testDecimalModel(): void
    {
        Assert::assertTrue((new ReflectionClass(Model::class))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Model::class, 'writeColumn'))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Model::class, 'readColumn'))->isInternal());
        $owner = new \Polyspec\Orm\Tests\DecimalModelTest('testDecimalModel');
        foreach (\Polyspec\Orm\Tests\DecimalModelTest::cases() as [$case, $column]) {
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
            } else {
                $model->setAmount($case['input']);
                Assert::assertSame(
                    $case['expected']['value'],
                    $model->getAmount(),
                    "{$case['id']}: native model value",
                );
            }
        }
        $owner->testGeneratedDecimalType();
    }

    public function testIdentityLoad(): void
    {
        $this->assertNativeIdentityLoadEntryPoints();
        $owner = new \Polyspec\Orm\Tests\IdentityLoadTest('testIdentityLoad');
        foreach (\Polyspec\Orm\Tests\IdentityLoadTest::cases() as [$case]) {
            if ($case['operation'] === 'compile') {
                $this->assertIdentityLoadCompileCase($case);
            } else {
                $owner->testIdentityLoad($case);
            }
        }
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
