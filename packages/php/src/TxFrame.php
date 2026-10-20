<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/** @internal one active transaction */
final class TxFrame
{
    public bool $finished = false;
    public int $savepoints = 0;
    /** @var array<string, string> */
    public array $locals = [];
    /** @var list<string> */
    public array $locks = [];
    /**
     * The table and primary key value of the audit record the transaction inserted before its first write
     * of an audited table.
     * That key is written to the audit column of audited rows. Until that write, and without audit values, it is null.
     *
     * @var array{table: string, key: mixed}|null
     */
    public ?array $audit = null;
    /**
     * The audit record the transaction inserts before its first write of an audited table, and null
     * without audit values.
     *
     * @var array{hash: string, entity: array, values: array<string, mixed>}|null
     */
    public ?array $pendingAudit = null;
    /**
     * The identity keys of the generated single inserts that the transaction succeeded in, by entity (INT-52).
     * A savepoint that does not release restores it.
     *
     * @var array<string, array<int, true>>
     */
    public array $inserted = [];

    /**
     * Records the identity key of a generated single insert in the write set of the transaction (INT-52). A batch insert
     * and an entity without an identity are not recorded. Db::writeOf and the extension's write path call it.
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

    /** @param int $number This transaction's number on the connection. A statement event carries it. */
    public function __construct(
        public readonly Db $db,
        public readonly bool $readOnly,
        public readonly string $isolation,
        public readonly int $number
    )
    {
    }
}
