<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\OrmException;

final class DatabaseTestAssertionsTest extends TestCase
{
    use DatabaseTestAssertions;

    public function testFixtureReaderAndCaseProviderPreserveValuesAndCaseIds(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'orm-fixture-');
        self::assertNotFalse($path);
        try {
            file_put_contents($path, '{"cases":[{"id":"fixture-case"}]}');
            $fixture = self::readJsonFixture($path);
            $castFixture = self::readJsonFixture($path, true);
            self::assertSame('fixture-case', $fixture['cases'][0]['id']);
            self::assertSame($fixture, $castFixture);
        } finally {
            if (is_string($path) && file_exists($path)) {
                unlink($path);
            }
        }
        $cases = iterator_to_array(self::fixtureCases([
            'cases' => [
                ['id' => 'case-a', 'input' => ['value' => '1']],
                ['id' => 'case-b', 'input' => ['value' => '2']],
            ],
        ]));
        self::assertSame(['case-a', 'case-b'], array_keys($cases));
        self::assertSame(['id' => 'case-a', 'input' => ['value' => '1']], $cases['case-a'][0]);
        self::assertSame(['id' => 'case-b', 'input' => ['value' => '2']], $cases['case-b'][0]);
    }

    public function testBenchDatabaseVariablesKeepCoverageDriverOrder(): void
    {
        self::assertSame(
            [
                'mysql' => 'BENCH_MYSQL_DSN',
                'postgres' => 'BENCH_POSTGRES_DSN',
                'sqlite' => 'BENCH_SQLITE_DSN',
            ],
            self::benchDatabaseVariables(),
            'bench database selection order and DSN names'
        );
    }

    public function testColumnUnselectedAssertionRequiresTheSharedErrorCode(): void
    {
        self::assertColumnUnselected(
            static fn() => throw new OrmException(Code::COLUMN_UNSELECTED, 'not selected'),
            'probe',
        );
    }

    public function testColumnUnselectedAssertionRejectsAnotherOrmCode(): void
    {
        $this->expectException(\PHPUnit\Framework\ExpectationFailedException::class);
        self::assertColumnUnselected(
            static fn() => throw new OrmException(Code::DRIVER, 'driver failure'),
            'probe',
        );
    }
}
