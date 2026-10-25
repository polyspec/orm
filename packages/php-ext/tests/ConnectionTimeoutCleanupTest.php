<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use DateTimeZone;
use PDO;
use PDOException;
use PDOStatement;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

final class ConnectionTimeoutCleanupPdo extends PDO
{
    public int $prepareCalls = 0;
    public int $closeCursorCalls = 0;
    public int $executeCalls = 0;
    public array $failureInfo = ['57014', null, 'statement timeout'];

    public function __construct()
    {
        parent::__construct('sqlite::memory:');
    }

    public function setAttribute(int $attribute, mixed $value): bool
    {
        return true;
    }

    public function prepare(string $query, array $options = []): PDOStatement|false
    {
        $this->prepareCalls++;
        if (
            !parent::setAttribute(
                PDO::ATTR_STATEMENT_CLASS,
                [ConnectionTimeoutCleanupStatement::class, [$this, $query]],
            )
        ) {
            throw new \RuntimeException('unable to configure the timeout cleanup fake statement');
        }
        return parent::prepare('SELECT 1');
    }
}

final class ConnectionTimeoutCleanupStatement extends PDOStatement
{
    protected function __construct(private readonly ConnectionTimeoutCleanupPdo $pdo, private readonly string $query)
    {
    }

    public function execute(?array $params = null): bool
    {
        if ($this->query !== 'SELECT 1') {
            throw new \RuntimeException("unexpected timeout cleanup SQL: {$this->query}");
        }
        $this->pdo->executeCalls++;
        if ($this->pdo->executeCalls === 1) {
            $error = new PDOException((string) $this->pdo->failureInfo[2]);
            $error->errorInfo = $this->pdo->failureInfo;
            throw $error;
        }
        return true;
    }

    public function closeCursor(): bool
    {
        $this->pdo->closeCursorCalls++;
        return true;
    }

    public function fetchAll(int $mode = PDO::FETCH_DEFAULT, mixed ...$args): array
    {
        return [];
    }
}

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
