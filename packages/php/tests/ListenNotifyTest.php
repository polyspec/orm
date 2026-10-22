<?php

declare(strict_types=1);

// LISTEN and NOTIFY on PostgreSQL (DIA-192 to DIA-196, PRT-74). A notification sent inside a transaction is delivered
// with its commit and dropped by a rollback; one sent outside a transaction is delivered at once; unlisten stops a
// channel; a receive whose deadline expires raises CANCELED; and MySQL and SQLite refuse notify and listen with
// CAPABILITY_UNSUPPORTED before any statement runs. Each case runs in a case database of its own (case_database.php),
// created through ORM_TEST_POSTGRES_DSN or ORM_TEST_MYSQL_DSN; the test fails when either is unset.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/ListenNotifyTest.php
require_once __DIR__ . '/case_database.php';

use Polyspec\Orm\Config;
use Polyspec\Orm\Code;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Orm;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
final class ListenNotifyTest extends TestCase
{
    public function test_listen_notify(): void
    {
        with_case_database('postgres', static function (string $message): void {
        }, static function (string $dsn): void {
            $db = Orm::connect($dsn, new Config());
            try {
                $subscription = $db->listen('t229_events');
                $db->transaction(static fn () => $db->notify('t229_events', 'committed'));
                $first = $subscription->receive(5.0);
                self::assertSame(['t229_events', 'committed'], [$first->channel, $first->payload]);

                try {
                    $db->transaction(static function () use ($db): void {
                        $db->notify('t229_events', 'rolled back');
                        throw new \RuntimeException('roll back');
                    });
                    self::fail('the transaction that fails did not fail');
                } catch (\RuntimeException) {
                }
                $db->notify('t229_events', 'outside');
                $second = $subscription->receive(5.0);
                self::assertSame('outside', $second->payload, 'the rolled back notification must not arrive');

                $subscription->unlisten('t229_events');
                $db->notify('t229_events', 'after unlisten');
                $subscription->close();

                $waiting = $db->listen('t229_cancel');
                try {
                    $waiting->receive(0.05);
                    self::fail('a receive with no notification returned');
                } catch (OrmException $e) {
                    self::assertSame(Code::CANCELED, $e->code_);
                }
                $waiting->close();
            } finally {
                $db->close();
            }
        });

        foreach (['sqlite', 'mysql'] as $driver) {
            with_case_database($driver, static function (string $message): void {
            }, static function (string $dsn) use ($driver): void {
                $db = Orm::connect($dsn, new Config());
                try {
                    foreach ([static fn () => $db->notify('t229_events', 'x'), static fn () => $db->listen('t229_events')] as $call) {
                        try {
                            $call();
                            self::fail("$driver accepted LISTEN or NOTIFY");
                        } catch (OrmException $e) {
                            self::assertSame(Code::CAPABILITY_UNSUPPORTED, $e->code_, $driver);
                        }
                    }
                } finally {
                    $db->close();
                }
            });
        }
    }
}
