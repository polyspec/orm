<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// INT-53 backendWaitingForLock on Polyspec\Orm\Utils with a waiter on PostgreSQL; the recipe utils
// holds the rest. The model is the clock fixture contracts/fixtures/clock.dbs, generated into a temporary directory
// under Polyspec\Orm\Tests\WasInsertedCase. Each case runs in a case database of its own (case_database.php); MySQL and
// PostgreSQL need ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN, and the test fails when either is unset.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/WasInsertedTest.php
// [--filter <case>]

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
final class WasInsertedTest extends TestCase
{
    /**
     * PostgreSQL: a second backend that waits for a row lock is reported. The transaction holds the row; a child
     * process updates the same row and blocks. The child prints "waiting" when the server reports that its update
     * waits (T475), and only then the parent reads the state once, before it commits and lets the child finish.
     */
    // Requirements: INT-53.
    public function testPostgresReportsABackendWaitingForLock(): void
    {
        WasInsertedCases::onCase('postgres', function (\Polyspec\Orm\Db $db, string $dsn): void {
            WasInsertedCases::assertReportsABackendWaitingForLock($this, $db, $dsn);
        });
    }
}
