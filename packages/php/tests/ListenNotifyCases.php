<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Config;
use Polyspec\Orm\Code;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Orm;

trait ListenNotifyCases
{
    public function runListenNotifyCases(): void
    {
        with_case_database('postgres', static function (string $message): void {
        }, static function (string $dsn): void {
            $db = Orm::connect($dsn, new Config());
            try {
                $subscription = $db->listen('t229_events');
                foreach (['', str_repeat('x', 64), str_repeat('é', 32), "bad\0channel"] as $channel) {
                    try {
                        $db->notify($channel, 'invalid channel');
                        self::fail('notify accepted invalid UTF-8 channel ' . bin2hex($channel));
                    } catch (OrmException $e) {
                        self::assertSame(Code::CONFIG, $e->code_);
                    }
                    try {
                        $db->listen($channel);
                        self::fail('listen accepted invalid UTF-8 channel ' . bin2hex($channel));
                    } catch (OrmException $e) {
                        self::assertSame(Code::CONFIG, $e->code_);
                    }
                }
                $db->notify(str_repeat('é', 31), 'valid 62-byte channel');
                foreach (
                    [
                        str_repeat('x', 8000),
                        str_repeat('x', 8001),
                        str_repeat('é', 4000),
                        str_repeat('é', 4001),
                        "bad\0payload",
                    ] as $payload
                ) {
                    try {
                        $db->notify('t229_events', $payload);
                        self::fail('notify accepted a PostgreSQL-invalid payload of ' . strlen($payload) . ' bytes');
                    } catch (OrmException $e) {
                        self::assertSame(Code::DRIVER, $e->code_);
                    }
                }
                $boundary = str_repeat('x', 7999);
                $db->transaction(static fn () => $db->notify('t229_events', 'committed'));
                $first = $subscription->receive(5.0);
                self::assertSame(['t229_events', 'committed'], [$first->channel, $first->payload]);
                $db->notify('t229_events', $boundary);
                self::assertSame($boundary, $subscription->receive(5.0)->payload);
                foreach (['buffer-1', 'buffer-2', 'buffer-3'] as $payload) {
                    $db->notify('t229_events', $payload);
                }
                self::assertSame(
                    ['buffer-1', 'buffer-2', 'buffer-3'],
                    [
                        $subscription->receive(5.0)->payload,
                        $subscription->receive(5.0)->payload,
                        $subscription->receive(5.0)->payload,
                    ],
                    'notifications received after waiting remain in arrival order'
                );

                try {
                    $db->transaction(static function () use ($db): void {
                        $db->notify('t229_events', 'rolled back');
                        throw new \RuntimeException('roll back');
                    });
                    self::fail('the transaction that fails did not fail');
                } catch (\RuntimeException $rolledBack) {
                    self::assertInstanceOf(\RuntimeException::class, $rolledBack, 'the transaction rolled back');
                }
                $db->notify('t229_events', 'outside');
                $second = $subscription->receive(5.0);
                self::assertSame('outside', $second->payload, 'the rolled back notification must not arrive');

                $subscription->unlisten('t229_events');
                $db->notify('t229_events', 'after unlisten');
                try {
                    $subscription->receive(0.05);
                    self::fail('a notification arrived after unlisten');
                } catch (OrmException $e) {
                    self::assertSame(Code::CANCELED, $e->code_, 'unlisten stopped delivery');
                }
                try {
                    $subscription->receive(0.05);
                    self::fail('a closed subscription received another notification');
                } catch (OrmException $e) {
                    self::assertSame(Code::CONFIG, $e->code_, 'receive after expiry is closed');
                }
                $subscription->close();

                $lostDb = Orm::connect($dsn, new Config());
                $lost = $lostDb->listen('t229_connection_lost');
                $lostDb->close();
                $server = getenv('ORM_TEST_POSTGRES_SERVER_DSN');
                self::assertIsString($server, 'the PostgreSQL server DSN is required');
                $name = ltrim((string) parse_url($dsn, PHP_URL_PATH), '/');
                [, $adminDsn, $user, $password] = Orm::parseDsn(case_dsn_with_database($server, $name));
                $admin = new \PDO($adminDsn, $user, $password, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
                $find = $admin->prepare(
                    'SELECT pid FROM pg_stat_activity WHERE datname = current_database() '
                    . 'AND pid <> pg_backend_pid() AND query = ? LIMIT 1'
                );
                $find->execute(['LISTEN "t229_connection_lost"']);
                $pid = $find->fetchColumn();
                self::assertNotFalse($pid, 'the listener backend is visible in pg_stat_activity');
                $terminate = $admin->prepare('SELECT pg_terminate_backend(?, 5000)');
                $terminate->execute([(int) $pid]);
                self::assertTrue((bool) $terminate->fetchColumn(), 'the listener backend was terminated');
                try {
                    $lost->receive(5.0);
                    self::fail('receive after connection loss returned a notification');
                } catch (OrmException $e) {
                    self::assertSame(Code::CONNECTION_LOST, $e->code_);
                }
                try {
                    $lost->receive(0.05);
                    self::fail('receive after connection loss accepted the closed subscription');
                } catch (OrmException $e) {
                    self::assertSame(Code::CONFIG, $e->code_);
                }
                $admin = null;

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
                    foreach (
                        [
                        static fn () => $db->notify('t229_events', 'x'),
                        static fn () => $db->listen('t229_events')
                        ] as $call
                    ) {
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
