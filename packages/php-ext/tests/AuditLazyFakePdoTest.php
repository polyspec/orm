<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use DateTimeZone;
use PDO;
use RuntimeException;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Tests\Model\AuditedNote;
use Polyspec\Orm\Tests\TransactionCloseDuringFailure;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
final class AuditLazyFakePdoTest extends TestCase
{
    use TransactionCloseDuringFailure;

    // Requirements: DSL-118, INT-45, PLN-13, PLN-20, PLN-44.
    public function testLazyAuditPrecedesWritesIsReusedAndWriteFailurePropagates(): void
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
            self::assertSame(
                ['audit-lazy-unit'],
                $executed[0]['params'],
                'audit creation is lazy and carries the transaction value',
            );
            self::assertSame(
                ['audit-lazy-unit'],
                $executed[2]['params'],
                'the unmatched update rolled back its audit before create',
            );
            self::assertCount(
                2,
                array_filter(
                    $executed,
                    static fn(array $operation): bool => str_starts_with(
                        $operation['sql'],
                        'INSERT',
                    ) && str_contains($operation['sql'], 'audit_record'),
                ),
            );
            self::assertSame(42, $executed[3]['params'][1], 'the first row insert binds the second audit identity');
            self::assertSame(
                $executed[3]['params'][1],
                $executed[4]['params'][1],
                'the later insert reuses the transaction audit identity',
            );
            self::assertCount(
                2,
                array_filter(
                    $executed,
                    static fn(array $operation): bool => str_contains(
                        $operation['sql'],
                        'INSERT',
                    ) && str_contains($operation['sql'], 'audited_note'),
                ),
            );
            self::assertSame([0], $pdo->affectedRows, 'the no-row update rolls back its audit before the later insert');
            self::assertSame(2, $pdo->auditReturningReads(), 'each audit record uses SQLite RETURNING exactly once');

            $controls = array_values(array_filter(
                array_map(
                    static fn(array $operation): string => $operation['sql'],
                    array_filter($pdo->operations, static fn(array $operation): bool => $operation['kind'] === 'exec')
                ),
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
            self::assertFalse($pdo->inTransaction(), 'the failed transaction releases its native transaction state');

            $db->transaction(static function () use ($db): void {
                (new AuditedNote())->connect($db)->setLabel('after-failure')->create();
            }, retry: 0, audit: ['request_id' => 'after-failure']);

            self::assertFalse($pdo->inTransaction(), 'the reused Db settles the following transaction too');
            self::assertSame(1, count(array_filter(
                $pdo->operations,
                static fn(array $operation): bool => $operation['kind'] === 'exec' && $operation['sql'] === 'COMMIT',
            )), 'the same native PDO commits a transaction after rollback');
            self::assertSame(1, count(array_filter(
                $pdo->operations,
                static fn(array $operation): bool => $operation['kind'] === 'exec' && $operation['sql'] === 'ROLLBACK',
            )), 'the original failure rolled back before the same Db committed again');
        } finally {
            $db->close();
        }
    }

    // Requirements: INT-67.
    public function testCloseDuringTransactionRollsBackBeforeReleasingNativeConnection(): void
    {
        $pdo = new AuditLazyFakePdo();
        $this->assertCloseDuringTransactionRollsBack($pdo, static fn(): array => array_column($pdo->operations, 'sql'));
    }
}
