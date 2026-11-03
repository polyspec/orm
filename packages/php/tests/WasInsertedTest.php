<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// INT-53 backendWaitingForLock on Polyspec\Orm\Utils with a waiter on PostgreSQL and on markdown; the recipe utils holds the rest. The model
// is the clock fixture contracts/fixtures/clock.dbs, generated into a temporary directory under
// Polyspec\Orm\Tests\WasInsertedCase. Each case runs in a case database of its own (case_database.php); MySQL and
// PostgreSQL need ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN, and the test fails when either is unset.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/WasInsertedTest.php
// [--filter <case>]

use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
final class WasInsertedTest extends TestCase
{
    /**
     * PostgreSQL: a second backend that waits for a row lock is reported. The transaction holds the row; a child
     * process updates the same row and blocks. The parent checks the state the database reports, bounded to ten
     * seconds, before it commits and lets the child finish.
     */
    // Requirements: INT-53.
    public function testPostgresReportsABackendWaitingForLock(): void
    {
        WasInsertedCases::onCase('postgres', static function (\Polyspec\Orm\Db $db, string $dsn): void {
            $seq = WasInsertedCases::heldEventSeq($db);
            $child = null;
            $pipes = [];
            $db->transaction(function () use ($db, $dsn, $seq, &$child, &$pipes): void {
                $child = WasInsertedCases::startLockWaiter($db, $dsn, $seq, $pipes);
                self::assertIsResource($child, 'the waiting child did not start');
                $waiting = false;
                for ($deadline = microtime(true) + 10; !$waiting && microtime(true) < $deadline; usleep(20000)) {
                    $waiting = $db->utils()->backendWaitingForLock();
                }
                self::assertTrue($waiting, 'the child backend waits for the row lock the transaction holds');
            }, retry: 0);
            self::assertIsResource($child);
            $output = stream_get_contents($pipes[1]);
            $errors = stream_get_contents($pipes[2]);
            fclose($pipes[1]);
            fclose($pipes[2]);
            self::assertSame(0, proc_close($child), "the child exited with an error: $errors");
            self::assertSame("done\n", $output);
        });
    }

    /**
     * The flowmark server has no backend view: INT-53 is CAPABILITY_UNSUPPORTED on the markdown driver, after the
     * connection.
     */
    public function testMarkdownHasNoBackendLockView(): void
    {
        $server = start_markdown_test_server(['{"ok":true}']);
        $db = Orm::connect($server[2], new Config());
        try {
            $error = markdown_error(static fn() => $db->utils()->backendWaitingForLock());
            self::assertSame(
                Code::CAPABILITY_UNSUPPORTED,
                $error?->code_ ?? 'none',
                'backendWaitingForLock on markdown'
            );
        } finally {
            $db->close();
        }
        markdown_test_server_received_messages($server);
    }
}
