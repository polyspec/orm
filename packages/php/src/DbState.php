<?php
declare(strict_types=1);

namespace Polyspec\Orm;

/**
 * @internal 한 연결의 모든 handle(Db와 그 withRequestHook handle)이 공유하는 상태다. Db만 읽고 쓴다.
 */
final class DbState
{
    /** 연결의 PDO handle이다. markdown 연결과 close한 연결은 null이고, 그 PDO가 해제되면 연결이 닫힌다. */
    public ?\PDO $pdo = null;
    /** @var array<string, \PDOStatement> */
    public array $stmts = [];
    /** @var list<string> */
    public array $stmtOrder = [];
    public bool $closed = false;
    /** Polyspec\Orm\Testing\Faults::failNextRollback가 설정하는 test fault다. 그 test entry point만 설정한다. */
    public bool $rollbackFault = false;
    /** Polyspec\Orm\Testing\Faults::failNextStatement가 설정하는 test fault다. 다음 statement 하나를 보내지 않고 이 오류로 끝낸다. 그 test entry point만 설정한다. */
    public ?OrmException $statementFault = null;
    /** @var array<string, true> 이 연결에 등록된 set의 manifest hash다. */
    public array $sets = [];
    /** @var array<int, \Closure(StatementEvent): void> statement event subscriber다. 등록 순서이고 key는 등록 번호다. */
    public array $subscribers = [];
    public int $subscriberSeq = 0;
    /** 연결의 바깥 transaction 번호다. 바깥 begin마다 하나 늘린다. */
    public int $transactions = 0;
    /** SQLite row lock table을 이 연결에서 만들었는지다. 연결의 첫 transaction 전에 한 번 만든다. */
    public bool $rowLockReady = false;
}
