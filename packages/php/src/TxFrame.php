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
     * transaction이 시작할 때 삽입한 audit 기록의 table과 primary key 값이다. 감사 대상 행의
     * audit column에 그 key를 쓴다. 없으면 null이다.
     *
     * @var array{table: string, key: mixed}|null
     */
    public ?array $audit = null;

    /** @param int $number 연결에서 이 transaction의 번호다. statement event가 싣는다. */
    public function __construct(public readonly Db $db, public readonly bool $readOnly, public readonly string $isolation, public readonly int $number) {}
}
