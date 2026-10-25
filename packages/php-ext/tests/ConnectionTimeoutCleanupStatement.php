<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PDO;
use PDOException;
use PDOStatement;

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
