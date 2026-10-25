<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PDO;
use PDOStatement;
use RuntimeException;

final class AuditLazyFakeStatement extends PDOStatement
{
    /** @var array<int|string, mixed> */
    private array $boundValues = [];

    protected function __construct(
        private readonly AuditLazyFakePdo $pdo,
        private readonly string $sql,
        private readonly bool $auditInsert,
        private readonly bool $noteInsert,
        private readonly bool $noteUpdate,
    ) {
    }

    public function bindValue(string|int $param, mixed $value, int $type = PDO::PARAM_STR): bool
    {
        $this->boundValues[$param] = $value;
        return true;
    }

    public function execute(?array $params = null): bool
    {
        $this->pdo->recordExecution(
            $this->sql,
            array_values($this->boundValues),
            $this->auditInsert,
            $this->noteInsert,
            $this->noteUpdate,
        );
        return true;
    }

    public function rowCount(): int
    {
        if (!$this->noteUpdate) {
            throw new RuntimeException("unexpected rowCount() for audit-lazy SQL: {$this->sql}");
        }
        return $this->pdo->nextUpdateAffectedRows();
    }

    public function columnCount(): int
    {
        return 0;
    }

    public function fetchAll(int $mode = PDO::FETCH_DEFAULT, mixed ...$args): array
    {
        throw new RuntimeException("unexpected fetchAll() for audit-lazy SQL: {$this->sql}");
    }

    public function fetchColumn(int $column = 0): mixed
    {
        if ($this->auditInsert) {
            $this->pdo->recordAuditReturningRead();
            return $this->pdo->nextAuditIdentity();
        }
        if ($this->noteInsert) {
            return $this->pdo->nextNoteIdentity();
        }
        throw new RuntimeException("unexpected fetchColumn() for audit-lazy SQL: {$this->sql}");
    }

    public function closeCursor(): bool
    {
        return true;
    }
}
