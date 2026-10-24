<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PDO;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use ReflectionMethod;
use RuntimeException;

final class ConnectionBusyTimeoutNativeTest extends TestCase
{
    // Requirements: CFG-12.
    public function testNativeSqliteBusyTimeoutCancelsWrite(): void
    {
        self::assertTrue((new ReflectionMethod(Orm::class, 'connect'))->isInternal());

        $path = tempnam(sys_get_temp_dir(), 'orm-busy-timeout-');
        self::assertIsString($path);
        unlink($path);

        $setup = null;
        $waiter = null;
        $holder = null;
        $failure = null;
        try {
            $setup = Orm::connect("sqlite://$path?_pragma=busy_timeout(5000)", new Config());
            $setup->pdo()->exec('CREATE TABLE busy_timeout_probe (id INTEGER PRIMARY KEY)');
            $setup->close();
            $setup = null;

            $holder = new PDO("sqlite:$path");
            $holder->exec('BEGIN IMMEDIATE');
            $waiter = Orm::connect("sqlite://$path?_pragma=busy_timeout(200)", new Config());

            $started = hrtime(true);
            try {
                $waiter->run('insert', [], null, 'INSERT INTO busy_timeout_probe (id) VALUES (1)');
                self::fail('a write blocked beyond busy_timeout must be canceled');
            } catch (OrmException $error) {
                self::assertSame(Code::CANCELED, $error->code_);
            }
            $elapsedMs = (hrtime(true) - $started) / 1_000_000;
            self::assertGreaterThanOrEqual(150, $elapsedMs, 'the configured busy timeout was applied');
        } catch (\Throwable $error) {
            $failure = $error;
        } finally {
            $cleanupErrors = [];
            if ($holder !== null) {
                try {
                    if ($holder->inTransaction()) {
                        $holder->exec('ROLLBACK');
                    }
                } catch (\Throwable $error) {
                    $cleanupErrors[] = $error;
                }
                $holder = null;
            }
            foreach ([$waiter, $setup] as $db) {
                if ($db === null) {
                    continue;
                }
                try {
                    $db->close();
                } catch (\Throwable $error) {
                    $cleanupErrors[] = $error;
                }
            }
            foreach ([$path, "$path-journal", "$path-wal", "$path-shm"] as $file) {
                if (is_file($file) && !unlink($file)) {
                    $cleanupErrors[] = new RuntimeException("unable to remove SQLite fixture $file");
                }
            }
            if ($cleanupErrors !== []) {
                $messages = array_map(static fn(\Throwable $error): string => $error->getMessage(), $cleanupErrors);
                throw new RuntimeException('SQLite busy-timeout fixture cleanup failed: ' . implode('; ', $messages), 0, $failure ?? $cleanupErrors[0]);
            }
        }

        if ($failure !== null) {
            throw $failure;
        }
    }
}
