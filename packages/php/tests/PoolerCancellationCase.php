<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Cancellation;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

/** CFG-31 for the PHP library and the extension: PgBouncer forwards a cancellation, and the root stays usable. */
trait PoolerCancellationCase
{
    private function assertPgBouncerForwardsCancellationAndRootRemainsUsable(): void
    {
        $base = requiredDsn('ORM_TEST_POSTGRES_DSN');
        $pooler = requiredDsn('ORM_TEST_PGBOUNCER_SINGLE_DSN');
        $table = 'orm_cancel_pooler_' . getmypid() . '_' . bin2hex(random_bytes(4));
        $setup = Orm::connect($base, new Config());
        $root = null;
        $failure = null;
        try {
            $setup->run('schema', [$table], null, "CREATE TABLE \"$table\" (value INTEGER)");
            $root = Orm::connect($pooler, new Config());
            $source = new Cancellation();
            $cancelled = $root->withCancellation($source);
            $pdo = $root->pdo();
            self::assertInstanceOf(\Pdo\Pgsql::class, $pdo);
            $activeNotice = false;
            $pdo->setNoticeCallback(static function (string $notice) use ($source, &$activeNotice): void {
                if (str_contains($notice, 'orm-cancel-pooler-active')) {
                    $activeNotice = true;
                    $source->cancel();
                }
            });

            try {
                $root->transaction(function () use ($root, $cancelled, $table): void {
                    $root->run('insert', [$table], 1, "INSERT INTO \"$table\" (value) VALUES (1)");
                    $cancelled->run(
                        'utility',
                        [],
                        1,
                        "DO \$pooler\$ BEGIN RAISE NOTICE 'orm-cancel-pooler-active'; "
                            . 'PERFORM pg_sleep(30); END $pooler$'
                    );
                    self::fail('PgBouncer should forward cancellation of an active statement');
                }, retry: 0);
                self::fail('the cancelled transaction should fail');
            } catch (OrmException $error) {
                self::assertSame(Code::CANCELED, $error->code_, $error->getMessage());
                self::assertTrue($activeNotice, 'the notice callback cancelled the active PgBouncer statement');
            }

            self::assertSame([[0]], $root->fetch(
                'select',
                [$table],
                null,
                "SELECT count(*) FROM \"$table\""
            ), 'the PgBouncer transaction rolled back the insert');
            self::assertSame([[1]], $root->fetch('select', [], null, 'SELECT 1'), 'the root handle remains usable');
        } catch (\Throwable $error) {
            $failure = $error;
        } finally {
            $cleanupErrors = [];
            if ($root !== null) {
                try {
                    $root->close();
                } catch (\Throwable $error) {
                    $cleanupErrors[] = $error;
                }
            }
            try {
                $setup->run('schema', [$table], null, "DROP TABLE IF EXISTS \"$table\"");
            } catch (\Throwable $error) {
                $cleanupErrors[] = $error;
            }
            try {
                $setup->close();
            } catch (\Throwable $error) {
                $cleanupErrors[] = $error;
            }
            if ($cleanupErrors !== []) {
                $messages = array_map(static fn(\Throwable $error): string => $error->getMessage(), $cleanupErrors);
                $cleanup = new \RuntimeException('PgBouncer cancellation cleanup failed: ' . implode('; ', $messages));
                throw $failure === null ? $cleanup : new \RuntimeException(
                    $failure->getMessage() . '; ' . $cleanup->getMessage(),
                    0,
                    $failure
                );
            }
        }
        if ($failure !== null) {
            throw $failure;
        }
    }
}
