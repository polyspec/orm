<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use DateTimeZone;
use PDOException;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
final class ConnectionTimeoutCleanupTest extends TestCase
{
    // Requirements: CFG-6.
    public function test_mysql_lock_wait_timeout_maps_to_canceled_and_closes_cursor(): void
    {
        $pdo = new ConnectionTimeoutCleanupPdo();
        $pdo->failureInfo = ['HY000', 1205, 'Lock wait timeout exceeded'];
        $db = new Db($pdo, 'mysql', new Config(), new DateTimeZone('UTC'));
        try {
            try {
                $db->fetch('query', [], null, 'SELECT 1');
                self::fail('a MySQL lock wait timeout must fail');
            } catch (\Polyspec\Orm\OrmException $error) {
                self::assertSame('CANCELED', $error->code_);
                self::assertInstanceOf(PDOException::class, $error->getPrevious());
                self::assertSame(['HY000', 1205, 'Lock wait timeout exceeded'], $error->getPrevious()->errorInfo);
            }

            self::assertSame(1, $pdo->closeCursorCalls, 'the failed native statement cursor is closed');
        } finally {
            $db->close();
        }
    }

    // Requirements: CFG-6.
    public function test_native_failed_statement_closes_cursor_and_reuses_connection(): void
    {
        $pdo = new ConnectionTimeoutCleanupPdo();
        $db = new Db($pdo, 'postgres', new Config(), new DateTimeZone('UTC'));
        try {
            try {
                $db->fetch('query', [], null, 'SELECT 1');
                self::fail('a PostgreSQL statement timeout must fail');
            } catch (\Polyspec\Orm\OrmException $error) {
                self::assertSame('CANCELED', $error->code_);
                self::assertInstanceOf(PDOException::class, $error->getPrevious());
                self::assertSame('57014', $error->getPrevious()->errorInfo[0]);
            }

            self::assertSame(1, $pdo->closeCursorCalls, 'the failed native statement cursor is closed');
            self::assertSame([], $db->fetch('query', [], null, 'SELECT 1'));
            self::assertSame(
                2,
                $pdo->prepareCalls,
                'the same connection prepares the next statement after cancellation',
            );
            self::assertSame(2, $pdo->executeCalls, 'the next statement executes after cancellation');
            self::assertSame(2, $pdo->closeCursorCalls, 'the successful statement cursor is closed too');
        } finally {
            $db->close();
        }
    }
}
