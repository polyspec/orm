<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/**
 * One active transaction; its run is the public statement call of INT-150. Its state and its constructor are
 * internal: Db and the extension write path own them.
 */
final class TxFrame
{
    /** @internal */
    public bool $finished = false;
    /** @internal */
    public bool $cancelled = false;
    /** @internal */
    public int $savepoints = 0;
    /** @internal @var array<string, string> */
    public array $locals = [];
    /** @internal @var list<string> */
    public array $locks = [];
    /**
     * The table and primary key value of the audit record the transaction inserted before its first write
     * of an audited table.
     * That key is written to the audit column of audited rows. Until that write, and without audit values, it is null.
     *
     * @var array{table: string, key: mixed}|null
     * @internal
     */
    public ?array $audit = null;
    /**
     * The audit record the transaction inserts before its first write of an audited table, and null
     * without audit values.
     *
     * @var array{hash: string, entity: array, values: array<string, mixed>}|null
     * @internal
     */
    public ?array $pendingAudit = null;
    /**
     * The identity keys of the generated single inserts that the transaction succeeded in, by entity (INT-52).
     * A savepoint that does not release restores it.
     *
     * @var array<string, array<int, true>>
     * @internal
     */
    public array $inserted = [];

    /**
     * Records the identity key of a generated single insert in the write set of the transaction (INT-52). A batch
     * insert and an entity without an identity are not recorded. Db::writeOf and the extension's write path call it.
     *
     * @internal
     */
    public static function recordInserted(?TxFrame $frame, Request $r, mixed $id): void
    {
        if ($frame === null || $r->ir['kind'] !== 'insert' || isset($r->ir['rows']) || $id === null) {
            return;
        }
        if (!is_int($id) && !(is_string($id) && ctype_digit($id))) {
            return;
        }
        $key = (int) $id;
        if ($key <= 0 || Registry::model($r->ir['manifest_hash'])->entity($r->ir['entity'])['identity'] === '') {
            return;
        }
        $frame->inserted[$r->ir['entity']][$key] = true;
    }

    /**
     * @param int $number This transaction's number on the connection. A statement event carries it.
     *
     * @internal
     */
    public function __construct(
        /** @internal */
        public readonly Db $db,
        /** @internal */
        public readonly bool $readOnly,
        /** @internal */
        public readonly string $isolation,
        /** @internal */
        public readonly int $number
    ) {
        $this->flow = \Fiber::getCurrent();
    }

    /** @internal The fiber that owns this transaction; the main request has no Fiber object. */
    public readonly ?\Fiber $flow;

    /**
     * Runs one statement of kind $kind that touches $tables (empty when none) in this transaction, publishes its
     * statement event (INT-77) and returns the statement result with its rows (INT-150). The frame never opens a
     * transaction. A statement that is not text is CONFIG; any other error is the database error code of the statement.
     *
     * @param list<string> $tables
     * @param list<mixed> $params
     * @return list<list<mixed>>
     */
    public function run(string $kind, array $tables, mixed $sql, array $params = []): array
    {
        if (!is_string($sql)) {
            throw new OrmException(Code::CONFIG, 'a statement must be text');
        }
        if ($this->finished) {
            throw new OrmException(Code::CONFIG, 'transaction already finished');
        }
        return $this->db->fetch($kind, $tables, $this->number, $sql, $params);
    }
}
