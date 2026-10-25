<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PDO;
use PDOStatement;
use RuntimeException;

final class AuditLazyFakePdo extends PDO
{
    /** @var list<array{kind: string, sql: string, params?: ?array}> */
    public array $operations = [];
    /** @var list<int> */
    public array $affectedRows = [];
    private bool $transaction = false;
    private int $auditIdentity = 40;
    private int $noteIdentity = 50;
    private int $updateExecutions = 0;
    private int $noteInsertExecutions = 0;
    private int $auditReturningReads = 0;
    public ?RuntimeException $updateFailure = null;

    public function __construct()
    {
        parent::__construct('sqlite::memory:');
    }

    public function setAttribute(int $attribute, mixed $value): bool
    {
        return true;
    }

    public function exec(string $statement): int|false
    {
        $known = $statement === 'CREATE TABLE IF NOT EXISTS "orm__row_lock" ("id" INTEGER PRIMARY KEY CHECK ("id" = 1))'
            || $statement === 'BEGIN IMMEDIATE'
            || $statement === 'SAVEPOINT orm_audit'
            || $statement === 'ROLLBACK TO SAVEPOINT orm_audit'
            || $statement === 'RELEASE SAVEPOINT orm_audit'
            || $statement === 'COMMIT'
            || $statement === 'ROLLBACK';
        if (!$known) {
            throw new RuntimeException("unexpected audit-lazy control SQL: $statement");
        }
        $this->operations[] = ['kind' => 'exec', 'sql' => $statement];
        if ($statement === 'BEGIN IMMEDIATE') {
            $this->transaction = true;
        } elseif ($statement === 'COMMIT' || $statement === 'ROLLBACK') {
            $this->transaction = false;
        }
        return 0;
    }

    public function prepare(string $query, array $options = []): PDOStatement|false
    {
        $auditInsert = preg_match('/^\s*INSERT\s+INTO\s+"?audit_record"?\b/is', $query) === 1;
        $noteInsert = preg_match('/^\s*INSERT\s+INTO\s+"?audited_note"?\b/is', $query) === 1;
        $noteUpdate = preg_match('/^\s*UPDATE\s+"?audited_note"?\b/is', $query) === 1;
        if (!$auditInsert && !$noteInsert && !$noteUpdate) {
            throw new RuntimeException("unexpected audit-lazy statement SQL: $query");
        }
        if (
            !parent::setAttribute(
                PDO::ATTR_STATEMENT_CLASS,
                [AuditLazyFakeStatement::class, [$this, $query, $auditInsert, $noteInsert, $noteUpdate]],
            )
        ) {
            throw new RuntimeException('unable to configure the fake PDO statement class');
        }
        return parent::prepare('SELECT 1');
    }

    public function inTransaction(): bool
    {
        return $this->transaction;
    }

    public function nextAuditIdentity(): string
    {
        return (string) ++$this->auditIdentity;
    }

    public function nextNoteIdentity(): string
    {
        return (string) ++$this->noteIdentity;
    }

    public function recordExecution(
        string $sql,
        ?array $params,
        bool $auditInsert,
        bool $noteInsert,
        bool $noteUpdate,
    ): void {
        $this->operations[] = ['kind' => 'execute', 'sql' => $sql, 'params' => $params];
        if ($noteInsert && ++$this->noteInsertExecutions === 2) {
            throw $this->updateFailure ?? new RuntimeException('unexpected second insert without configured failure');
        }
        if (!$auditInsert && !$noteInsert && !$noteUpdate) {
            throw new RuntimeException("unclassified audit-lazy statement SQL: $sql");
        }
    }

    public function nextUpdateAffectedRows(): int
    {
        $this->affectedRows[] = count($this->affectedRows) === 0 ? 0 : 1;
        return $this->affectedRows[array_key_last($this->affectedRows)];
    }

    public function recordAuditReturningRead(): void
    {
        $this->auditReturningReads++;
    }

    public function auditReturningReads(): int
    {
        return $this->auditReturningReads;
    }
}
