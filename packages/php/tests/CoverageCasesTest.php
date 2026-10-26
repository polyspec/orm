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

    private static function auditLazyOutput(
        int|bool $updateSequence,
        int|bool $createSequence,
        string $updateTable = 'audited_note',
    ): string {
        return json_encode([
            'audit_lazy' => [
                'result' => ['before' => 0],
                'statements' => [
                    ['kind' => 'insert', 'tables' => ['audit_record'], 'binds' => ['audit-lazy']],
                    ['kind' => 'update', 'tables' => [$updateTable], 'binds' => ['audit-none', $updateSequence, -1]],
                    ['kind' => 'insert', 'tables' => ['audit_record'], 'binds' => ['audit-lazy']],
                    ['kind' => 'insert', 'tables' => ['audited_note'], 'binds' => ['audit-lazy', $createSequence]],
                    ['kind' => 'select', 'tables' => ['audited_note'], 'binds' => [900004]],
                ],
            ],
        ], JSON_THROW_ON_ERROR);
    }

    public function testAuditLazyNormalizationUsesOnlyTheObservedUpdateIdentity(): void
    {
        $output = json_decode(
            \coverageCanonicalConformanceOutput('mysql', 'audit_lazy', self::auditLazyOutput(900005, 900006)),
            true,
            512,
            JSON_THROW_ON_ERROR,
        );
        self::assertSame('$SEQ', $output['audit_lazy']['statements'][1]['binds'][1]);
        self::assertSame(2, $output['audit_lazy']['statements'][3]['binds'][1]);
        self::assertSame(900004, $output['audit_lazy']['statements'][4]['binds'][0]);
    }

    public function testAuditLazyNormalizationRejectsAnInvalidObservedIdentity(): void
    {
        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessage('sequence bind is not a positive integer');
        \coverageCanonicalConformanceOutput('mysql', 'audit_lazy', self::auditLazyOutput(false, 900006));
    }

    public function testAuditLazyNormalizationRequiresTheGuardedUpdateStatement(): void
    {
        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessage('one audited-note update');
        \coverageCanonicalConformanceOutput(
            'mysql',
            'audit_lazy',
            self::auditLazyOutput(900005, 900006, 'audit_record'),
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

    public function testRestoresWholeConformanceCounterSnapshotAfterSuccessAndFailure(): void
    {
        $directory = sys_get_temp_dir() . '/orm-counter-restore-' . bin2hex(random_bytes(8));
        self::assertTrue(mkdir($directory, 0700), 'temporary counter fixture directory');
        $initialPath = "$directory/initial.json";
        $statePath = "$directory/state.json";
        $restorePath = "$directory/restores.jsonl";
        $logPath = "$directory/calls.log";
        $nodePath = "$directory/node";
        $original = [
            'audit_record' => ['value' => '17', 'called' => true, 'owner' => ''],
            'audited_note' => ['value' => '29', 'called' => true, 'owner' => ''],
            'unrelated_identity' => ['value' => '41', 'called' => false, 'owner' => 'other_table'],
        ];
        $encodedOriginal = json_encode($original, JSON_THROW_ON_ERROR);
        $node = <<<'SH'
#!/bin/sh
set -eu
previous=
restore=
snapshot=
while [ "$#" -gt 0 ]; do
    if [ "$previous" = restore-json ]; then
        snapshot=$1
        restore=1
        break
    fi
    if [ "$1" = --restore-json ]; then previous=restore-json; else previous=; fi
    shift
done
if [ "$restore" = 1 ]; then
    printf 'restore\n' >> "$COUNTER_FIXTURE_LOG"
    printf '%s\n' "$snapshot" >> "$COUNTER_FIXTURE_RESTORES"
    printf '%s' "$snapshot" > "$COUNTER_FIXTURE_STATE"
else
    printf 'read\n' >> "$COUNTER_FIXTURE_LOG"
    if [ -f "$COUNTER_FIXTURE_STATE" ]; then cat "$COUNTER_FIXTURE_STATE"; else cat "$COUNTER_FIXTURE_INITIAL"; fi
fi
SH;
        $previousPath = getenv('PATH');
        $previousInitial = getenv('COUNTER_FIXTURE_INITIAL');
        $previousState = getenv('COUNTER_FIXTURE_STATE');
        $previousRestores = getenv('COUNTER_FIXTURE_RESTORES');
        $previousLog = getenv('COUNTER_FIXTURE_LOG');
        try {
            self::assertSame(strlen($encodedOriginal), file_put_contents($initialPath, $encodedOriginal));
            self::assertSame(strlen($node), file_put_contents($nodePath, $node));
            self::assertTrue(chmod($nodePath, 0700), 'counter CLI fixture is executable');
            putenv('PATH=' . $directory . PATH_SEPARATOR . ($previousPath === false ? '' : $previousPath));
            putenv("COUNTER_FIXTURE_INITIAL=$initialPath");
            putenv("COUNTER_FIXTURE_STATE=$statePath");
            putenv("COUNTER_FIXTURE_RESTORES=$restorePath");
            putenv("COUNTER_FIXTURE_LOG=$logPath");
            $mutated = $original;
            $mutated['audit_record']['value'] = '18';
            $mutated['audited_note']['value'] = '30';
            $mutated['unrelated_identity']['value'] = '42';
            $encodedMutation = json_encode($mutated, JSON_THROW_ON_ERROR);
            coverageWithConformanceCountersRestored(
                'sqlite',
                'sqlite:///unused-by-counter-fixture',
                static function () use ($statePath, $encodedMutation): void {
                    self::assertSame(strlen($encodedMutation), file_put_contents($statePath, $encodedMutation));
                },
            );
            self::assertSame($encodedOriginal, file_get_contents($statePath), 'success restores every counter');

            $failure = new RuntimeException('conformance body failed');
            try {
                coverageWithConformanceCountersRestored(
                    'sqlite',
                    'sqlite:///unused-by-counter-fixture',
                    static function () use ($statePath, $encodedMutation, $failure): void {
                        file_put_contents($statePath, $encodedMutation);
                        throw $failure;
                    },
                );
                self::fail('the conformance body failure must propagate');
            } catch (RuntimeException $caught) {
                self::assertSame($failure, $caught, 'cleanup preserves the original body exception');
            }

            self::assertSame($encodedOriginal, file_get_contents($statePath), 'failure restores every counter');
            self::assertSame(
                ['read', 'restore', 'read', 'read', 'restore', 'read'],
                file($logPath, FILE_IGNORE_NEW_LINES),
                'each success and failure path reads, restores, and verifies counters',
            );
            self::assertSame(
                [$encodedOriginal, $encodedOriginal],
                file($restorePath, FILE_IGNORE_NEW_LINES),
                'both cleanup calls serialize the complete original counter map',
            );
        } finally {
            $previousPath === false ? putenv('PATH') : putenv("PATH=$previousPath");
            $previousInitial === false
                ? putenv('COUNTER_FIXTURE_INITIAL')
                : putenv("COUNTER_FIXTURE_INITIAL=$previousInitial");
            $previousState === false
                ? putenv('COUNTER_FIXTURE_STATE')
                : putenv("COUNTER_FIXTURE_STATE=$previousState");
            $previousRestores === false
                ? putenv('COUNTER_FIXTURE_RESTORES')
                : putenv("COUNTER_FIXTURE_RESTORES=$previousRestores");
            $previousLog === false ? putenv('COUNTER_FIXTURE_LOG') : putenv("COUNTER_FIXTURE_LOG=$previousLog");
            foreach ([$initialPath, $statePath, $restorePath, $logPath, $nodePath] as $path) {
                if (file_exists($path)) {
                    unlink($path);
                }
            }
            rmdir($directory);
        }
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

    public function testReadsTheRecordedConformanceVectorsOfTheSelectedDatabase(): void
    {
        $files = ['mysql' => 'vectors.json', 'postgres' => 'vectors.postgres.json', 'sqlite' => 'vectors.sqlite.json'];
        foreach ($files as $driver => $name) {
            $recorded = coverageJson(dirname(__DIR__, 3) . "/tests/conformance/$name", false);
            self::assertEquals(
                [$name, coverageExpectedConformanceVectors($recorded, ['relations', 'conditions_values'])],
                coverageRecordedConformanceVectors($driver, ['relations', 'conditions_values']),
                $driver
            );
        }
        try {
            coverageRecordedConformanceVectors('sqlite', ['conditions_values', 'no_such_vector']);
            self::fail('a vector that the file does not record must fail');
        } catch (\PHPUnit\Framework\AssertionFailedError $error) {
            self::assertStringContainsString('vectors.sqlite.json lacks a selected vector', $error->getMessage());
        }
    }

    public function testAuditLazyCounterBaselineCopiesAndChangesOnlyOwnedCounters(): void
    {
        $mysql = [
            'audit_record' => ['value' => '43', 'called' => false],
            'audited_note' => ['value' => '8', 'called' => false],
            'other_table' => ['value' => '12', 'called' => true],
        ];
        $mysqlBaseline = coverageAuditLazyCounterBaseline('mysql', $mysql);
        self::assertSame([
            'audit_record' => ['value' => '1', 'called' => true],
            'audited_note' => ['value' => '1', 'called' => true],
            'other_table' => ['value' => '12', 'called' => true],
        ], $mysqlBaseline);
        self::assertSame('43', $mysql['audit_record']['value'], 'the original snapshot remains unchanged');

        $postgres = [
            'audit_record_id_seq' => ['value' => '43', 'called' => true, 'owner' => 'audit_record'],
            'audited_note_id_seq' => ['value' => '8', 'called' => true, 'owner' => 'audited_note'],
            'other_id_seq' => ['value' => '12', 'called' => true, 'owner' => 'other_table'],
        ];
        self::assertSame([
            'audit_record_id_seq' => ['value' => '1', 'called' => false, 'owner' => 'audit_record'],
            'audited_note_id_seq' => ['value' => '1', 'called' => false, 'owner' => 'audited_note'],
            'other_id_seq' => ['value' => '12', 'called' => true, 'owner' => 'other_table'],
        ], coverageAuditLazyCounterBaseline('postgres', $postgres));

        $sqlite = [
            'audit_record' => ['value' => '43', 'called' => false],
            'unrelated' => ['value' => '12', 'called' => true],
        ];
        self::assertSame([
            'audit_record' => ['value' => '0', 'called' => true],
            'unrelated' => ['value' => '12', 'called' => true],
        ], coverageAuditLazyCounterBaseline('sqlite', $sqlite));
        self::assertSame(['value' => '43', 'called' => false], $sqlite['audit_record']);
    }

    public function testAuditLazyCounterBaselineRejectsIncompleteSnapshots(): void
    {
        try {
            coverageAuditLazyCounterBaseline('mysql', []);
            self::fail('missing MySQL audit counters must fail');
        } catch (RuntimeException $error) {
            self::assertStringContainsString('audit_record AUTO_INCREMENT', $error->getMessage());
        }
        try {
            coverageAuditLazyCounterBaseline('postgres', [
                'audit_record_id_seq' => ['value' => '4', 'called' => true, 'owner' => 'audit_record'],
            ]);
            self::fail('missing PostgreSQL owned sequence must fail');
        } catch (RuntimeException $error) {
            self::assertStringContainsString('no sequence owned by audited_note', $error->getMessage());
        }
        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessage('unsupported conformance driver oracle');
        coverageAuditLazyCounterBaseline('oracle', []);
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
