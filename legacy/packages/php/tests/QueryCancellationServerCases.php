<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use DateTimeZone;
use PDO;
use Pdo\Sqlite;
use Polyspec\Orm\Cancellation;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Orm;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

/**
 * The cancellation tests of QueryCancellationTest and of the extension's QueryCancellationNativeTest on the PostgreSQL
 * and MySQL servers. They are a trait of their own, so the MariaDB class, which uses the cases of
 * QueryCancellationDbCases on its server (DIA-200), runs none of them again.
 */
trait QueryCancellationServerCases
{
    use QueryCancellationDbCases;

    // Requirements: CFG-9.
    public function testPostgresNoticeCancelsActiveStatementRollsBackAndReusesRoot(): void
    {
        with_case_database('postgres', static function (): void {
        }, static function (string $dsn): void {
            $root = Orm::connect($dsn, new Config());
            $source = new Cancellation();
            $cancelled = $root->withCancellation($source);
            $pdo = $root->pdo();
            self::assertInstanceOf(\Pdo\Pgsql::class, $pdo);
            $originalPid = $pdo->getPid();
            $activeNotice = false;
            $pdo->setNoticeCallback(static function (string $notice) use ($source, &$activeNotice): void {
                if (str_contains($notice, 'orm-cancel-active')) {
                    $activeNotice = true;
                    $source->cancel();
                }
            });

            try {
                $root->run(
                    'schema',
                    ['cancellation_rollback'],
                    null,
                    'CREATE TABLE cancellation_rollback (value INTEGER)'
                );
                try {
                    $root->transaction(function () use ($root, $cancelled): void {
                        $root->run(
                            'insert',
                            ['cancellation_rollback'],
                            1,
                            'INSERT INTO cancellation_rollback (value) VALUES (1)'
                        );
                        $cancelled->run(
                            'utility',
                            [],
                            1,
                            "DO \$cancel\$ BEGIN RAISE NOTICE 'orm-cancel-active'; PERFORM pg_sleep(30); END \$cancel\$"
                        );
                        self::fail('the active PostgreSQL statement should be terminated');
                    }, retry: 0);
                    self::fail('the cancelled transaction should fail');
                } catch (OrmException $error) {
                    self::assertSame(Code::CANCELED, $error->code_, $error->getMessage());
                    self::assertTrue($activeNotice, 'the notice callback ran while the statement was active');
                }

                self::assertSame(
                    $originalPid,
                    $root->pdo()->getPid(),
                    'the logical root handle reuses its cancelled backend after rollback'
                );
                self::assertRolledBackAndUsable($root);
            } finally {
                $root->close();
            }
        });
    }

    // Requirements: CFG-9.
    public function testMysqlLockEventCancelsActiveStatementRollsBackAndReconnectsRoot(): void
    {
        self::lockEventCancelsActiveStatementRollsBackAndReconnectsRoot('mysql');
    }

    // Requirements: CFG-9.
    public function testMysqlCancellationStopsEveryActiveRootAndReopensEachProcessRoot(): void
    {
        self::cancellationStopsEveryActiveRootAndReopensEachProcessRoot('mysql');
    }
}
