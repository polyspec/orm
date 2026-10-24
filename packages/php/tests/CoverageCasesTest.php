<?php

// Unit test of the feature coverage helper (packages/php/tests/coverage_cases.php). The helper
// is shared by packages/php/tests/Coverage*Test.php, so a change to it is checked by this
// test (the helpers in contracts/features.json), not by the coverage of all features. Full coverage is run by make
// orm-check.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use DateTimeZone;
use PDO;
use PDOStatement;
use RuntimeException;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use PHPUnit\Framework\Attributes\DataProviderExternal;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\OrmException;

#[Small]
final class CoverageCasesTest extends TestCase
{
    /** @return iterable<string, array{string}> */
    public static function databaseDrivers(): iterable
    {
        return coverageDatabaseDrivers();
    }

    public function testEnumeratesTheSupportedCoverageDatabases(): void
    {
        $this->assertSame(
            ['sqlite' => ['sqlite'], 'mysql' => ['mysql'], 'postgres' => ['postgres']],
            iterator_to_array(coverageDatabaseDrivers()),
            'coverage database cases'
        );
    }

    public function testEntryClassAssertionAllowsLibraryMode(): void
    {
        self::assertNotSame('extension', getenv('ORM_PHP_MODE'), 'this helper unit runs in library mode');
        coverageAssertEntryClassesAreInternal();
    }

    public function testTableLookupUsesTheSelectedCatalogWithoutADatabaseServer(): void
    {
        $queries = [
            'mysql' => 'SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND '
                . 'TABLE_NAME = ?',
            'postgres' => 'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = current_schema() AND '
                . 'table_name = ?',
            'sqlite' => "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
        ];
        foreach ($queries as $driver => $query) {
            foreach ([1 => true, 0 => false] as $count => $exists) {
                $executions = [];
                $pdo = new class ($count, $executions) extends PDO {
                    /** @var list<array{string, ?array}> */
                    public array $executions;

                    /** @param list<array{string, ?array}> $executions */
                    public function __construct(private readonly int $count, array &$executions)
                    {
                        $this->executions =& $executions;
                    }

                    public function setAttribute(int $attribute, mixed $value): bool
                    {
                        return true;
                    }

                    public function prepare(string $query, array $options = []): PDOStatement|false
                    {
                        $executions =& $this->executions;
                        $record = static function (?array $params) use (&$executions, $query): void {
                            $executions[] = [$query, $params];
                        };
                        return new class ($this->count, $record) extends PDOStatement {
                            public function __construct(
                                private readonly int $count,
                                private readonly \Closure $record
                            ) {
                            }

                            public function execute(?array $params = null): bool
                            {
                                ($this->record)($params);
                                return true;
                            }

                            public function fetchColumn(int $column = 0): mixed
                            {
                                return $this->count;
                            }
                        };
                    }
                };
                $db = new Db($pdo, $driver, new Config(), new DateTimeZone('UTC'));
                self::assertSame($exists, coverageTableExists($db, 'users'), "$driver row count $count");
                self::assertSame([[$query, ['users']]], $executions, "$driver catalog query");
            }
        }
    }

    public function testReportsErrorCodesAndRestoreFailures(): void
    {
        $this->assertSame(Code::CONFIG, coverageCode(static function (): void {
            throw new OrmException(Code::CONFIG, 'bad');
        }), 'code');
        $this->assertSame('no error', coverageCode(static function (): void {
        }), 'no error');
        $restored = false;
        coverageRestoring(static function (): void {
        }, static function () use (&$restored): void {
            $restored = true;
        });
        $this->assertTrue($restored, 'restore after success');
        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessage('case failed: body; restore failed: cleanup');
        coverageRestoring(
            static function (): void {
                throw new RuntimeException('body');
            },
            static function (): void {
                throw new RuntimeException('cleanup');
            },
        );
    }

    public function testRequiresTheSelectedDatabase(): void
    {
        $GLOBALS['orm_coverage_item'] = null;
        try {
            coverageItem();
            $this->fail('coverageItem accepted no selected item');
        } catch (RuntimeException $e) {
            $this->assertStringContainsString('no coverage item is selected', $e->getMessage(), 'missing');
        }
        selectCoverageItem(['sqlite', 'sqlite:///tmp/x.sqlite']);
        $this->assertSame(['sqlite', 'sqlite:///tmp/x.sqlite'], coverageItem(), 'selected');
        $GLOBALS['orm_coverage_item'] = null;
    }

    public function testCoverageItemsCanSelectOneDatabaseWithoutOtherDsns(): void
    {
        $this->withSelectedSQLiteEnvironment(function (): void {
            $items = coverageItemsOf(__DIR__ . '/CoverageConstraintsAndRelationsTest.php');
            self::assertNotSame([], $items, 'the feature test has declared coverage items');
            foreach ($items as [$database, $dsn]) {
                self::assertSame('sqlite', $database, 'only the selected database is returned');
                self::assertSame('sqlite:///selected.sqlite', $dsn, 'the selected database DSN is preserved');
            }
        });
    }

    public function testSelectsOnlyTheRequestedConformanceExpectations(): void
    {
        $recorded = (object) [
            'vectors' => [
                (object) ['name' => 'conditions_values', 'expect' => ['values' => [1, 2]]],
                (object) ['name' => 'ignored', 'expect' => ['values' => [3]]],
                (object) ['name' => 'relations', 'expect' => ['related' => true]],
            ],
        ];
        self::assertSame(
            [
                'conditions_values' => ['values' => [1, 2]],
                'relations' => ['related' => true],
            ],
            coverageExpectedConformanceVectors($recorded, ['conditions_values', 'relations']),
        );
    }

    public function testModelQueryRunnerSelectsOwnerAndClosesItsConnection(): void
    {
        $connections = [];
        $seen = [];
        $this->withSelectedSQLiteEnvironment(function () use (&$connections, &$seen): void {
            coverageRunDatabaseItems(
                __DIR__ . '/CoverageModelQueriesTest.php',
                static function (Db $db) use (&$seen): void {
                    $seen[] = coverageItem();
                },
                static function (string $dsn) use (&$connections): Db {
                    self::assertSame('sqlite:///selected.sqlite', $dsn);
                    $db = new Db(new PDO('sqlite::memory:'), 'sqlite', new Config(), new DateTimeZone('UTC'));
                    $connections[] = $db;
                    return $db;
                },
            );
            self::assertSame([['sqlite', 'sqlite:///selected.sqlite']], $seen);
            self::assertCount(1, $connections);
            try {
                $connections[0]->pdo();
                self::fail('coverage runner left its database connection open');
            } catch (OrmException $error) {
                self::assertSame(Code::CONFIG, $error->code_);
            }
        });
    }

    public function testRunsAChildProcess(): void
    {
        [$status, $stdout, $stderr] = coverageProcess(
            [PHP_BINARY, '-r', 'echo "out"; fwrite(STDERR, "err"); exit(3);'],
            __DIR__
        );
        $this->assertSame([3, 'out', 'err'], [$status, $stdout, $stderr], 'child');
    }

    private function withSelectedSQLiteEnvironment(callable $test): void
    {
        $previousDatabase = getenv('ORM_FEATURE_DATABASE');
        $previousSqliteDsn = getenv('BENCH_SQLITE_DSN');
        putenv('ORM_FEATURE_DATABASE=sqlite');
        putenv('BENCH_SQLITE_DSN=sqlite:///selected.sqlite');
        try {
            $test();
        } finally {
            if ($previousDatabase === false) {
                putenv('ORM_FEATURE_DATABASE');
            } else {
                putenv("ORM_FEATURE_DATABASE=$previousDatabase");
            }
            $previousSqliteDsn === false ? putenv('BENCH_SQLITE_DSN') : putenv("BENCH_SQLITE_DSN=$previousSqliteDsn");
        }
    }
}
