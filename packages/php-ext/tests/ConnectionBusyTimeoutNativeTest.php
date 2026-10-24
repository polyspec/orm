<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PDO;
use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use ReflectionMethod;
use RuntimeException;

final class ConnectionBusyTimeoutNativeTest extends TestCase
{
    // Requirements: CFG-12. This case enters the connection and transaction paths through the C extension.
    #[Large]
    public function testNativeConnectionsCommitConcurrentSqliteWriters(): void
    {
        self::assertTrue((new ReflectionMethod(Orm::class, 'connect'))->isInternal());
        $path = tempnam(sys_get_temp_dir(), 'orm-sqlite-writers-');
        self::assertIsString($path);
        unlink($path);
        $dbs = [];
        $children = [];
        $failure = null;
        try {
            self::assertTrue(function_exists('pcntl_fork'), 'the native SQLite process test requires pcntl');
            $setup = Orm::connect("sqlite://$path", new Config());
            $setup->pdo()->exec('CREATE TABLE orm_writer_probe (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
            $setup->close();
            for ($writer = 0; $writer < 8; $writer++) {
                $pid = pcntl_fork();
                if ($pid === -1) {
                    throw new RuntimeException('unable to fork SQLite writer');
                }
                if ($pid === 0) {
                    try {
                        $db = Orm::connect("sqlite://$path", new Config());
                        for ($index = 0; $index < 10; $index++) {
                            $db->transaction(static function () use ($db, $writer, $index): void {
                                $db->run('query', [], null, 'SELECT COUNT(*) FROM orm_writer_probe');
                                $db->run('insert', [], null, "INSERT INTO orm_writer_probe (label) VALUES ('writer-$writer-$index')");
                            }, retry: 0);
                        }
                        $db->close();
                        exit(0);
                    } catch (\Throwable $error) {
                        fwrite(STDERR, "SQLite writer $writer: {$error->getMessage()}\n");
                        exit(1);
                    }
                }
                $children[] = $pid;
            }
            foreach ($children as $pid) {
                $status = 0;
                pcntl_waitpid($pid, $status);
                $children = array_values(array_diff($children, [$pid]));
                self::assertTrue(pcntl_wifexited($status) && pcntl_wexitstatus($status) === 0, "writer process $pid succeeds");
            }
            $dbs[] = Orm::connect("sqlite://$path", new Config());
            self::assertSame(80, (int) $dbs[0]->pdo()->query('SELECT COUNT(*) FROM orm_writer_probe')->fetchColumn());
        } catch (\Throwable $error) {
            $failure = $error;
        } finally {
            $cleanupErrors = [];
            foreach ($children as $pid) {
                posix_kill($pid, SIGTERM);
                pcntl_waitpid($pid, $status);
            }
            foreach ($dbs as $db) {
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
                throw new RuntimeException('SQLite writer fixture cleanup failed: ' . implode('; ', $messages), 0, $failure ?? $cleanupErrors[0]);
            }
        }
        if ($failure !== null) {
            throw $failure;
        }
    }

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
