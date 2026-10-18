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
     * The table and primary key value of the audit record inserted when the transaction started. That key is written to the
     * audit column of audited rows. If there is none, it is null.
     *
     * @var array{table: string, key: mixed}|null
     */
    public ?array $audit = null;

    /** @param int $number This transaction's number on the connection. A statement event carries it. */
    public function __construct(public readonly Db $db, public readonly bool $readOnly, public readonly string $isolation, public readonly int $number) {}
}
