<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

require_once dirname(__DIR__, 3) . '/packages/php/gen/bootstrap.php';

use DateTimeZone;
use PDO;
use PDOStatement;
use RuntimeException;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Tests\Model\AuditedNote;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

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
        if (!parent::setAttribute(PDO::ATTR_STATEMENT_CLASS, [AuditLazyFakeStatement::class, [$this, $query, $auditInsert, $noteInsert, $noteUpdate]])) {
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

    public function recordExecution(string $sql, ?array $params, bool $auditInsert, bool $noteInsert, bool $noteUpdate): void
    {
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
    ) {}

    public function bindValue(string|int $param, mixed $value, int $type = PDO::PARAM_STR): bool
    {
        $this->boundValues[$param] = $value;
        return true;
    }

    public function execute(?array $params = null): bool
    {
        $this->pdo->recordExecution($this->sql, array_values($this->boundValues), $this->auditInsert, $this->noteInsert, $this->noteUpdate);
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

#[Small]
final class AuditLazyFakePdoTest extends TestCase
{
    public function test_lazy_audit_precedes_writes_is_reused_and_write_failure_propagates(): void
    {
        $pdo = new AuditLazyFakePdo();
        $failure = new RuntimeException('audited update execution failed');
        $pdo->updateFailure = $failure;
        $db = new Db($pdo, 'sqlite', new Config(auditSource: static fn(): array => []), new DateTimeZone('UTC'));
        $db->registerSet(\Polyspec\Orm\Tests\Model\schema());

        try {
            $caught = null;
            try {
                $db->transaction(static function () use ($db): void {
                    (new AuditedNote())->connect($db)->setSeq(-1)->setLabel('audit-none')->update();
                    (new AuditedNote())->connect($db)->setLabel('audit-created')->create();
                    (new AuditedNote())->connect($db)->setLabel('audit-fails')->create();
                }, retry: 0, audit: ['request_id' => 'audit-lazy-unit']);
            } catch (RuntimeException $error) {
                $caught = $error;
            }

            $executed = array_values(array_filter(
                $pdo->operations,
                static fn(array $operation): bool => $operation['kind'] === 'execute',
            ));

            self::assertSame([
                'audit_record', 'audited_note', 'audit_record', 'audited_note', 'audited_note',
            ], array_map(static function (array $operation): string {
                preg_match('/^\s*(?:INSERT\s+INTO|UPDATE)\s+"?([a-z_]+)"?/i', $operation['sql'], $match);
                return $match[1] ?? '';
            }, $executed));
            self::assertSame(['audit-lazy-unit'], $executed[0]['params'], 'audit creation is lazy and carries the transaction value');
            self::assertSame(['audit-lazy-unit'], $executed[2]['params'], 'the unmatched update rolled back its audit before create');
            self::assertCount(2, array_filter($executed, static fn(array $operation): bool => str_starts_with($operation['sql'], 'INSERT') && str_contains($operation['sql'], 'audit_record')));
            self::assertSame(42, $executed[3]['params'][1], 'the first row insert binds the second audit identity');
            self::assertSame($executed[3]['params'][1], $executed[4]['params'][1], 'the later insert reuses the transaction audit identity');
            self::assertCount(2, array_filter($executed, static fn(array $operation): bool => str_contains($operation['sql'], 'INSERT') && str_contains($operation['sql'], 'audited_note')));
            self::assertSame([0], $pdo->affectedRows, 'the no-row update rolls back its audit before the later insert');
            self::assertSame(2, $pdo->auditReturningReads(), 'each audit record uses SQLite RETURNING exactly once');

            $controls = array_values(array_filter(
                array_map(static fn(array $operation): string => $operation['sql'],
                    array_filter($pdo->operations, static fn(array $operation): bool => $operation['kind'] === 'exec')),
                static fn(string $sql): bool => !str_starts_with($sql, 'CREATE TABLE IF NOT EXISTS "orm__row_lock"'),
            ));
            self::assertSame([
                'BEGIN IMMEDIATE',
                'SAVEPOINT orm_audit',
                'ROLLBACK TO SAVEPOINT orm_audit',
                'RELEASE SAVEPOINT orm_audit',
                'ROLLBACK',
            ], $controls, 'SQLite uses its native begin, audit savepoint settlement, and outer rollback protocol');
            self::assertSame($failure, $caught, 'the native transaction must propagate the original write failure');
        } finally {
            $db->close();
        }
    }
}
