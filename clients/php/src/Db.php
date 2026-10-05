<?php
declare(strict_types=1);

namespace Orm;

/**
 * A database connection: the PDO handle, its engine, the statement cache,
 * and the transactions of the request.
 */
final class Db
{
    public const DRIVERS = ['mysql', 'postgres', 'sqlite'];
    public const SECRET = '$SECRET';
    public const NOW = '$NOW';
    /** SQLite row lock을 대신하는 table이다. row lock statement가 가리킨다. */
    private const ROW_LOCK_TABLE = 'orm__row_lock';

    /** @var list<TxFrame> active transactions of the request, innermost last */
    private static array $frames = [];
    /** 요청이 끝날 때 남은 transaction을 정리하는 함수를 이 요청에 등록했는지다. */
    private static bool $endRegistered = false;

    /** 연결의 PDO handle이다. close한 연결은 null이다. */
    private ?\PDO $pdo;
    /**
     * 이 Db가 지금 연결에 statement를 보냈는지다. 보내기 전에 정한다. 첫 statement가 연결을 잃은
     * 오류로 실패하면 연결을 다시 열고 그 statement를 한 번 다시 보낸다(send).
     */
    private bool $sent = false;

    /** @var array<string, \PDOStatement> */
    private array $stmts = [];
    /** @var list<string> */
    private array $stmtOrder = [];
    private bool $closed = false;
    /** @var array<int, string> masked bind positions of the last args() result */
    private array $masks = [];
    private bool $typed = false;
    /** Orm\Testing\Faults::failNextRollback가 설정하는 test fault다. 그 test entry point만 설정한다. */
    private bool $rollbackFault = false;
    /** @var array<string, true> 이 연결에 등록된 set의 manifest hash다. */
    private array $sets = [];
    /** @var array<int, \Closure(StatementEvent): void> statement event subscriber다. 등록 순서이고 key는 등록 번호다. */
    private array $subscribers = [];
    private int $subscriberSeq = 0;
    /** 연결의 바깥 transaction 번호다. 바깥 begin마다 하나 늘린다. */
    private int $transactions = 0;
    /** SQLite row lock table을 이 연결에서 만들었는지다. 연결의 첫 transaction 전에 한 번 만든다. */
    private bool $rowLockReady = false;
    private readonly string $driver;

    /** @internal Orm::connect creates connections. */
    public function __construct(
        private readonly Connection $connection,
        private readonly Config $config,
        private readonly \DateTimeZone $zone,
    ) {
        $this->driver = $connection->driver;
        $this->pdo = $connection->open();
    }

    /** Db가 끝나면 연결의 slot을 pool에 돌려준다. persistent slot의 연결은 다음 Db가 다시 쓴다. */
    public function __destruct()
    {
        $this->pdo = null;
        $this->connection->release();
    }

    /**
     * The configured maximum of connections a process holds for this
     * database at once (Config poolSize); zero when the Db has no pool.
     */
    public function poolSize(): int
    {
        return $this->config->poolSize;
    }

    /**
     * @internal Orm::connectSchema와 SchemaUtils의 register, install만 부른다. schema의 set을
     * 이 연결에 등록한다. 같은 set을 다시 등록하면 아무것도 바꾸지 않는다.
     */
    public function registerSet(Schema $schema): void
    {
        $schema->verify();
        Registry::schema($schema);
        $this->sets[$schema->manifestHash] = true;
    }

    /** The database of the connection: mysql, postgres, or sqlite. */
    public function driver(): string
    {
        return $this->driver;
    }

    /** @internal the connection time zone */
    public function zone(): \DateTimeZone
    {
        return $this->zone;
    }

    /** @internal */
    public function config(): Config
    {
        return $this->config;
    }

    /**
     * @internal the PDO handle for statements that the caller sends itself; the
     * connection counts them as sent, so a lost connection is not reopened
     * for a later statement of the Db
     */
    public function pdo(): \PDO
    {
        $this->sent = true;
        return $this->handle();
    }

    /** 연결의 PDO handle이다. close한 연결은 CONFIG다. */
    private function handle(): \PDO
    {
        if ($this->closed) {
            throw new OrmException(Code::CONFIG, 'database is closed');
        }
        if ($this->pdo === null) {
            throw new OrmException(Code::CONNECTION_LOST, 'the connection was lost and opening it again failed');
        }
        return $this->pdo;
    }

    /** @internal 이 연결의 driver 오류를 error catalog의 code로 보고한다. */
    public function driverError(\PDOException $e): OrmException
    {
        return OrmException::fromDriver($e, $this->driver, $this->handle());
    }

    /** The operations outside the query syntax. */
    public function utils(): Utils
    {
        return new Utils($this);
    }

    /**
     * Releases cached statements and the connection; the Db cannot be used
     * afterwards. A pooled connection returns to the pool of the process.
     */
    public function close(): void
    {
        if ($this->closed) {
            return;
        }
        try {
            foreach ($this->stmts as $st) {
                $st->closeCursor();
            }
        } catch (\PDOException $e) {
            throw $this->driverError($e);
        } finally {
            $this->closed = true;
            $this->stmts = [];
            $this->stmtOrder = [];
            $this->pdo = null;
            $this->connection->release();
        }
    }

    // ---- statement events ----

    /**
     * Registers $subscriber for the event of every statement the connection
     * sends (docs/usage.md "Statement events"). Subscribers run in
     * registration order, after the statement and before the operation
     * continues. A subscriber must not throw: an exception fails the
     * operation with SUBSCRIBER, whose previous exception it is, and the
     * statement keeps its effect. The returned closure removes the
     * subscription.
     *
     * @param \Closure(StatementEvent): void $subscriber
     * @return \Closure(): void
     */
    public function subscribe(\Closure $subscriber): \Closure
    {
        $id = $this->subscriberSeq++;
        $this->subscribers[$id] = $subscriber;
        return function () use ($id): void {
            unset($this->subscribers[$id]);
        };
    }

    /** @internal 새 바깥 transaction의 번호다. */
    public function nextTransaction(): int
    {
        return ++$this->transactions;
    }

    /** @internal 연결의 진행 중인 transaction 번호다. transaction 밖이면 null이다. */
    public function transactionNumber(): ?int
    {
        return self::activeFor($this)?->number;
    }

    /**
     * @internal 끝난 statement의 event를 subscriber에게 publish한다. subscriber가 던지면 남은
     * subscriber를 부르지 않고 SUBSCRIBER를 던진다. 그 previous가 subscriber의 오류다.
     * subscriber가 없으면 목록이 빈 것만 확인한다. $start는 statement를 보내기 전의 hrtime이다.
     *
     * @param list<string> $tables
     * @param list<mixed> $binds
     */
    public function publish(string $kind, array $tables, ?int $transaction, string $sql, array $binds, int $start, ?OrmException $error): void
    {
        if ($this->subscribers === []) {
            return;
        }
        $elapsed = (hrtime(true) - $start) / 1e9;
        foreach ($binds as $i => $v) {
            if ($v instanceof Bytes) {
                $binds[$i] = $v->bytes;
            }
        }
        $event = new StatementEvent($sql, array_values($binds), $kind, $tables, $elapsed, $transaction, $error);
        // 목록의 복사본을 돈다. subscriber가 구독을 풀어도 이번 event의 순서는 그대로다.
        foreach ($this->subscribers as $subscriber) {
            try {
                $subscriber($event);
            } catch (\Throwable $e) {
                throw new OrmException(Code::SUBSCRIBER, 'statement event subscriber failed: ' . $e->getMessage(), $e);
            }
        }
    }

    /**
     * @internal model이 아닌 statement 하나를 보내고 event를 publish한다. $send는 statement를
     * 실행해 결과를 돌려준다. driver 오류는 mapping한 OrmException으로 event에 싣고 던진다.
     *
     * @template T
     * @param list<string> $tables
     * @param list<mixed> $binds
     * @param \Closure(): T $send
     * @return T
     */
    public function observed(string $kind, array $tables, ?int $transaction, string $sql, array $binds, \Closure $send): mixed
    {
        $this->handle();
        return $this->send($send, function (int $start, ?OrmException $error) use ($kind, $tables, $transaction, $sql, $binds): void {
            $this->publish($kind, $tables, $transaction, $sql, $binds, $start, $error);
        });
    }

    /**
     * statement 하나를 보내고 그 event를 publish한다. $send는 statement를 보내 결과를 돌려주고,
     * $done은 statement를 보내기 전의 hrtime과 오류로 event를 publish한다. 이 Db의 첫 statement가
     * 연결을 잃은 오류(CONNECTION_LOST)로 실패하면 그 연결에서 이 Db의 statement가 실행된 적이
     * 없으므로 연결을 다시 열고 statement를 한 번 다시 보낸다. 다른 오류와 그 뒤의 오류는 그대로
     * 던진다. 실패한 시도도 event다.
     *
     * @template T
     * @param \Closure(): T $send
     * @param \Closure(int, ?OrmException): void $done
     * @return T
     */
    private function send(\Closure $send, \Closure $done): mixed
    {
        $resend = !$this->sent;
        while (true) {
            $this->sent = true;
            $start = hrtime(true);
            try {
                $result = $send();
            } catch (\PDOException $e) {
                $error = $this->driverError($e);
                $done($start, $error);
                if (!$resend || $error->code_ !== Code::CONNECTION_LOST) {
                    throw $error;
                }
                $resend = false;
                $this->reconnect();
                continue;
            }
            $done($start, null);
            return $result;
        }
    }

    /**
     * 잃은 연결을 버리고 같은 slot의 연결을 새로 연다. 옛 handle의 statement를 먼저 버린다. PDO는
     * persistent slot의 끊긴 연결을 확인하고 새로 연다.
     */
    private function reconnect(): void
    {
        $this->stmts = [];
        $this->stmtOrder = [];
        $this->pdo = null;
        $this->pdo = $this->connection->open();
    }

    /**
     * @internal bind도 행도 없는 statement 하나를 실행한다. transaction 제어와 schema statement가
     * 쓴다.
     *
     * @param list<string> $tables
     */
    public function run(string $kind, array $tables, ?int $transaction, string $sql): void
    {
        $this->observed($kind, $tables, $transaction, $sql, [], fn() => $this->handle()->exec($sql));
    }

    /**
     * @internal model이 아닌 statement 하나를 실행하고 그 행을 위치 순 값으로 돌려준다. 행이 없는
     * statement는 빈 목록이다. PostgreSQL text의 $n placeholder는 pdo_pgsql이 받는 ?로 바꿔
     * 보낸다. event의 sql은 text 그대로다.
     *
     * @param list<string> $tables
     * @param list<mixed> $args
     * @return list<list<mixed>>
     */
    public function fetch(string $kind, array $tables, ?int $transaction, string $sql, array $args = []): array
    {
        return $this->observed($kind, $tables, $transaction, $sql, $args, function () use ($sql, $args): array {
            $text = $sql;
            $bound = $args;
            if ($this->driver === 'postgres') {
                // 같은 $n이 여러 번 나오면 ?마다 그 값을 다시 bind한다.
                $bound = [];
                $text = preg_replace_callback('/\$(\d+)/', static function (array $m) use ($args, &$bound): string {
                    $bound[] = $args[(int) $m[1] - 1];
                    return '?';
                }, $sql);
            }
            $st = $this->handle()->prepare($text);
            $st->execute($bound);
            $rows = $st->columnCount() > 0 ? $st->fetchAll(\PDO::FETCH_NUM) : [];
            $st->closeCursor();
            return $rows;
        });
    }

    public static function bindLimit(string $driver): int
    {
        return $driver === 'sqlite' ? 999 : 65535;
    }

    private function stmt(string $sql): \PDOStatement
    {
        $pdo = $this->handle();
        if (isset($this->stmts[$sql])) {
            return $this->stmts[$sql];
        }
        // pdo_pgsql numbers placeholders itself; the plan's $n are in slot order.
        $st = $pdo->prepare($this->driver === 'postgres' ? preg_replace('/\$\d+/', '?', $sql) : $sql);
        $this->stmts[$sql] = $st;
        $this->stmtOrder[] = $sql;
        while (count($this->stmtOrder) > $this->config->statementCacheSize) {
            $oldest = array_shift($this->stmtOrder);
            $this->stmts[$oldest]->closeCursor();
            unset($this->stmts[$oldest]);
        }
        return $st;
    }

    // ---- transactions ----

    /** @internal the innermost active transaction of the connection */
    public static function activeFor(Db $db): ?TxFrame
    {
        for ($i = count(self::$frames) - 1; $i >= 0; $i--) {
            if (self::$frames[$i]->db === $db) {
                return self::$frames[$i];
            }
        }
        return null;
    }

    /**
     * @internal where a model runs: the active transaction of its connection,
     * the connection, or the innermost transaction for a model without one.
     * @return array{0: Db, 1: ?TxFrame}
     */
    public static function resolve(?Db $conn): array
    {
        if ($conn !== null) {
            if ($conn->closed) {
                throw new OrmException(Code::CONFIG, 'database is closed');
            }
            return [$conn, self::activeFor($conn)];
        }
        $frame = self::$frames[count(self::$frames) - 1] ?? null;
        if ($frame === null) {
            throw new OrmException(Code::CONFIG, 'the model has no connection; use connect or run it inside a transaction');
        }
        return [$frame->db, $frame];
    }

    /** @internal runs $fn in a transaction of $conn, or directly inside the active one */
    public static function inTransaction(?Db $conn, \Closure $fn): void
    {
        if ($conn === null) {
            if (self::$frames === []) {
                throw new OrmException(Code::CONFIG, 'the model has no connection; use connect or run it inside a transaction');
            }
            $fn();
            return;
        }
        $conn->transaction($fn, retry: 0);
    }

    /**
     * Runs $fn in one transaction and returns its result. An exception rolls
     * back; models without connect inside $fn use this transaction. A
     * transaction of the same connection inside an active one creates a
     * savepoint and accepts only retry, which it ignores.
     *
     * $audit은 이 작업 단위의 audit 기록 값(column => 값)이다. 값이 있으면 transaction은 시작하기
     * 전에 연결 설정의 auditSource를 한 번 부르고, 시도마다 callback 전에 그 값에 $audit을 더한(같은
     * column이면 $audit이 이긴다) 행 하나를 연결에 등록한 set의 audit 기록 table에 삽입한다.
     * transaction 안의 모든 감사 대상 insert, update, soft delete, restore는 그 primary key를 audit
     * column에 쓴다(docs/dbspec.md "Audit"). source가 없거나, 기록 table이 하나가 아니거나, 값의
     * key가 그 table의 column이 아니면 transaction을 시작하기 전에 CONFIG다.
     * 중첩 transaction은 바깥 transaction의 audit을 쓰며 $audit을 받지 않는다.
     *
     * @param array<string, mixed>|null $audit
     */
    public function transaction(\Closure $fn, string $isolation = '', bool $readOnly = false, int $timeoutMs = 0, int $retry = 3, ?array $audit = null): mixed
    {
        if ($retry < 0) {
            throw new OrmException(Code::CONFIG, 'transaction retry must not be negative');
        }
        if ($timeoutMs < 0) {
            throw new OrmException(Code::CONFIG, 'transaction timeoutMs must not be negative');
        }
        if (!in_array($isolation, ['', 'read_uncommitted', 'read_committed', 'repeatable_read', 'serializable'], true)) {
            throw new OrmException(Code::CONFIG, "unsupported transaction isolation $isolation");
        }
        $outer = self::activeFor($this);
        if ($audit !== null && $outer === null) {
            $record = $this->auditRecord($audit);
            $inner = $fn;
            $fn = function () use ($record, $inner): mixed {
                $frame = self::activeFor($this);
                $frame->audit = $this->insertAudit($frame, $record);
                return $inner();
            };
        }
        if ($outer !== null) {
            if ($isolation !== '' || $readOnly || $timeoutMs !== 0 || $audit !== null) {
                throw new OrmException(Code::CONFIG, 'a nested transaction of the same connection accepts only the retry option');
            }
            return $this->savepoint($outer, $fn);
        }
        for ($attempt = 0; ; $attempt++) {
            try {
                return $this->runTransaction($fn, $isolation, $readOnly, $timeoutMs);
            } catch (OrmException $e) {
                if ($e->code_ !== Code::DEADLOCK || $attempt >= $retry) {
                    throw $e;
                }
                usleep((50000 << $attempt) + random_int(0, 20000));
            }
        }
    }

    /**
     * audit source의 값에 transaction의 값을 더한 audit 기록이다. 같은 column이면 transaction의 값이
     * 이긴다. 기록 table은 연결에 등록한 set의 audit setting이 references로 이름한 table 하나이며, 그
     * table을 entity로 가진 set이 연결에 등록되어 있어야 한다. audit source가 없거나, 기록 table이
     * 없거나 여럿이거나, 값의 key가 그 table의 column이 아니거나, primary key가 column 하나가
     * 아니면 CONFIG다. source는 transaction을 시작하기 전에 한 번 부르며 그 예외는 그대로 전한다.
     *
     * @param array<string, mixed> $values
     * @return array{hash: string, entity: array, values: array<string, mixed>}
     */
    private function auditRecord(array $values): array
    {
        $source = $this->config->auditSource ?? throw new OrmException(Code::CONFIG, 'the transaction has audit values but the connection has no audit source: set Config auditSource');
        $models = [];
        foreach (array_keys($this->sets) as $hash) {
            $models[$hash] = Registry::model($hash);
        }
        $tables = [];
        foreach ($models as $model) {
            foreach ($model->entities as $entity) {
                if ($entity['audit_record'] !== '' && !in_array($entity['audit_record'], $tables, true)) {
                    $tables[] = $entity['audit_record'];
                }
            }
        }
        sort($tables, SORT_STRING);
        if ($tables === []) {
            throw new OrmException(Code::CONFIG, 'the transaction has audit values but no set of the connection has an audited table');
        }
        if (count($tables) > 1) {
            throw new OrmException(Code::CONFIG, 'the audited tables of the connection record their audits in ' . implode(', ', $tables) . '; one audit record table is required');
        }
        $target = null;
        foreach ($models as $hash => $model) {
            foreach ($model->entities as $entity) {
                if ($entity['table'] === $tables[0]) {
                    $target = ['hash' => $hash, 'entity' => $entity];
                }
            }
        }
        if ($target === null) {
            throw new OrmException(Code::CONFIG, "the audit record table {$tables[0]} is not a table of a set registered on the connection");
        }
        if (count($target['entity']['pk']) !== 1) {
            throw new OrmException(Code::CONFIG, "the audit record table {$tables[0]} needs a primary key of one column");
        }
        $merged = [];
        foreach ([$source(), $values] as $set) {
            ksort($set, SORT_STRING);
            foreach ($set as $column => $value) {
                if (!isset($target['entity']['columns'][$column])) {
                    throw new OrmException(Code::CONFIG, "audit value $column is not a column of {$tables[0]}");
                }
                $merged[$column] = $value;
            }
        }
        if ($merged === []) {
            throw new OrmException(Code::CONFIG, "the audit record of {$tables[0]} has no value: the audit source and the transaction give none");
        }
        $target['values'] = $merged;
        return $target;
    }

    /**
     * transaction의 audit 기록을 삽입하고 그 table과 primary key 값을 돌려준다. primary key가
     * identity이면 생성된 key, 아니면 기록의 값이다. 시도마다 다시 삽입한다.
     *
     * @param array{hash: string, entity: array, values: array<string, mixed>} $record
     * @return array{table: string, key: mixed}
     */
    private function insertAudit(TxFrame $frame, array $record): array
    {
        $entity = $record['entity'];
        $r = new Request('insert', $record['hash']);
        $r->ir['entity'] = $entity['entity'];
        $values = $record['values'];
        ksort($values, SORT_STRING);
        foreach ($values as $column => $value) {
            $value = $value === null ? null : Model::encodeValue($entity['columns'][$column], $value);
            $r->ir['set'][] = $value === null ? ['column' => $column, 'null' => true] : ['column' => $column, 'p' => $r->param($value)];
        }
        [$id] = $this->writeOf($frame, $r);
        $pk = $entity['pk'][0];
        $key = $entity['identity'] === $pk ? ($id === null ? null : (int) $id) : ($values[$pk] ?? null);
        if ($key === null) {
            throw new OrmException(Code::CONFIG, "the audit record {$entity['table']} has no $pk after its insert");
        }
        return ['table' => $entity['table'], 'key' => $key];
    }

    private function runTransaction(\Closure $fn, string $isolation, bool $readOnly, int $timeoutMs): mixed
    {
        $frame = $this->begin($isolation, $readOnly, $timeoutMs);
        self::$frames[] = $frame;
        try {
            $v = $fn();
        } catch (\Throwable $e) {
            array_pop(self::$frames);
            $failure = $e instanceof \PDOException ? $this->driverError($e) : $e;
            try {
                $this->finish($frame, false);
            } catch (\Throwable $cleanup) {
                // callback 오류와 transaction 끝의 오류를 함께 보고한다(docs/interfaces.md).
                throw OrmException::rollback($failure, $cleanup);
            }
            if ($this->rollbackFault) {
                $this->rollbackFault = false;
                throw OrmException::rollback($failure, new OrmException(Code::FAULT, 'test fault: the rollback of the transaction ran and is reported as failed'));
            }
            throw $failure;
        }
        array_pop(self::$frames);
        $this->finish($frame, true);
        return $v;
    }

    private function begin(string $isolation, bool $readOnly, int $timeoutMs): TxFrame
    {
        if ($this->closed) {
            throw new OrmException(Code::CONFIG, 'database is closed');
        }
        if ($timeoutMs > 0 && $this->driver !== 'postgres') {
            throw new OrmException(Code::CAPABILITY_UNSUPPORTED, 'transaction timeoutMs is supported only by postgres');
        }
        $level = strtoupper(str_replace('_', ' ', $isolation));
        if ($this->driver === 'sqlite') {
            // SQLite의 row lock table은 연결의 첫 transaction 전에 transaction 밖에서 한 번 만든다.
            $this->ensureRowLockTable();
        }
        if (!self::$endRegistered) {
            register_shutdown_function(self::endRequest(...));
            self::$endRegistered = true;
        }
        $frame = new TxFrame($this, $readOnly, $isolation, $this->nextTransaction());
        // transaction을 여는 statement다(docs/usage.md "Statement events"). driver의 transaction
        // API 대신 client가 이 text를 그대로 보낸다.
        $steps = [];
        switch ($this->driver) {
            case 'mysql':
                if ($level !== '') {
                    $steps[] = [StatementEvent::UTILITY, 'SET TRANSACTION ISOLATION LEVEL ' . $level];
                }
                $steps[] = [StatementEvent::BEGIN, $readOnly ? 'START TRANSACTION READ ONLY' : 'START TRANSACTION'];
                break;
            case 'postgres':
                $steps[] = [StatementEvent::BEGIN, 'BEGIN' . ($level !== '' ? ' ISOLATION LEVEL ' . $level : '') . ($readOnly ? ' READ ONLY' : '')];
                if ($timeoutMs > 0) {
                    $steps[] = [StatementEvent::UTILITY, 'SET LOCAL statement_timeout = ' . $timeoutMs];
                }
                break;
            default:
                // 쓰기 transaction은 시작할 때 쓰기 lock을 잡고 busy_timeout까지 기다린다. 읽기 전용
                // transaction은 deferred BEGIN이다.
                $steps[] = [StatementEvent::BEGIN, $readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE'];
                if ($isolation === 'read_uncommitted') {
                    $steps[] = [StatementEvent::UTILITY, 'PRAGMA read_uncommitted = 1'];
                }
                if ($readOnly) {
                    $steps[] = [StatementEvent::UTILITY, 'PRAGMA query_only = 1'];
                }
        }
        foreach ($steps as [$kind, $sql]) {
            try {
                $this->run($kind, [], $frame->number, $sql);
            } catch (OrmException $failure) {
                // 시작한 transaction은 SQLite mode까지 되돌리고 rollback한다. BEGIN이 실행된 뒤
                // subscriber가 실패해도 transaction은 시작했으므로 driver의 상태로 판단한다.
                if (!$this->handle()->inTransaction()) {
                    throw $failure;
                }
                try {
                    $this->finish($frame, false);
                } catch (\Throwable $cleanup) {
                    throw OrmException::rollback($failure, $cleanup);
                }
                throw $failure;
            }
        }
        return $frame;
    }

    /**
     * 요청이 transaction 안에서 끝나면(exit, fatal error) 끝나지 않은 transaction을 안쪽부터 끝낸다:
     * MySQL named lock과 local 값, SQLite mode를 되돌리고 rollback한다. pool의 연결은 다음 요청이
     * 다시 쓰므로 요청이 연결에 남긴 상태를 넘기지 않는다. 요청이 끝날 때 한 번 실행되며, 실패를 모두
     * 모아 던진다.
     */
    private static function endRequest(): void
    {
        $errors = [];
        $ended = [];
        while (($frame = array_pop(self::$frames)) !== null) {
            $id = spl_object_id($frame);
            if ($frame->finished || isset($ended[$id]) || $frame->db->closed) {
                continue;
            }
            $ended[$id] = true;
            try {
                $frame->db->finish($frame, false);
            } catch (\Throwable $e) {
                $errors[] = $e;
            }
        }
        $failure = self::joined($errors);
        if ($failure !== null) {
            throw $failure;
        }
    }

    /** SQLite 연결의 row lock table을 연결에서 처음 한 번 만든다. */
    private function ensureRowLockTable(): void
    {
        if ($this->rowLockReady) {
            return;
        }
        $this->run(StatementEvent::UTILITY, [self::ROW_LOCK_TABLE], null, 'CREATE TABLE IF NOT EXISTS "orm__row_lock" ("id" INTEGER PRIMARY KEY CHECK ("id" = 1))');
        $this->rowLockReady = true;
    }

    /**
     * transaction을 끝낸다. 끝내기 전에 MySQL named lock을 풀고 MySQL local 값을
     * 지우고 SQLite mode를 되돌린다. 이 상태는 COMMIT과 ROLLBACK 뒤에도
     * connection에 남으므로 모든 단계를 시도하고 실패를 모두 보고한다. cleanup이
     * 실패한 commit은 rollback하고 cleanup 오류를 던진다.
     */
    private function finish(TxFrame $frame, bool $commit): void
    {
        $frame->finished = true;
        $failure = self::joined($this->cleanup($frame));
        if ($commit && $failure === null) {
            try {
                $this->run(StatementEvent::COMMIT, [], $frame->number, 'COMMIT');
                return;
            } catch (OrmException $e) {
                $failure = $e;
            }
        }
        $rollback = null;
        try {
            // 실패한 COMMIT은 server가 transaction을 끝냈을 수 있으므로 남은 transaction만
            // rollback한다. 작업이 실패한 transaction은 언제나 rollback하며, driver나
            // server가 transaction이나 connection을 이미 끝내 실패한 rollback도 보고한다.
            if (!$commit || $this->handle()->inTransaction()) {
                $this->run(StatementEvent::ROLLBACK, [], $frame->number, 'ROLLBACK');
            }
        } catch (OrmException $e) {
            $rollback = $e;
        }
        if ($commit) {
            throw $rollback === null ? $failure : OrmException::rollback($failure, $rollback);
        }
        $failure = self::joined(array_values(array_filter([$failure, $rollback])));
        if ($failure !== null) {
            throw $failure;
        }
    }

    /** @return list<\Throwable> transaction 끝의 cleanup에서 실패한 단계들이다. */
    private function cleanup(TxFrame $frame): array
    {
        $errors = [];
        $attempt = function (callable $step) use (&$errors): void {
            try {
                $step();
            } catch (OrmException $e) {
                $errors[] = $e;
            }
        };
        foreach ($frame->locks as $key) {
            $attempt(function () use ($key, $frame): void {
                $released = $this->fetch(StatementEvent::UTILITY, [], $frame->number, 'SELECT RELEASE_LOCK(?)', [$key])[0][0] ?? null;
                // 1이 아니면 이 connection이 lock을 갖고 있지 않았다.
                if ((string) $released !== '1') {
                    throw new OrmException(Code::CONFIG, "lock $key was not held at transaction end");
                }
            });
        }
        $frame->locks = [];
        if ($this->driver === 'mysql') {
            // 값을 지우는 statement는 key 순서로 보낸다.
            $keys = array_map('strval', array_keys($frame->locals));
            sort($keys, SORT_STRING);
            foreach ($keys as $key) {
                $attempt(fn() => $this->run(StatementEvent::UTILITY, [], $frame->number, 'SET @`orm.' . $key . '` = NULL'));
            }
        }
        if ($this->driver === 'sqlite') {
            if ($frame->readOnly) {
                $attempt(fn() => $this->run(StatementEvent::UTILITY, [], $frame->number, 'PRAGMA query_only = 0'));
            }
            if ($frame->isolation === 'read_uncommitted') {
                $attempt(fn() => $this->run(StatementEvent::UTILITY, [], $frame->number, 'PRAGMA read_uncommitted = 0'));
            }
        }
        return $errors;
    }

    /** @param list<\Throwable> $errors 하나면 그 오류, 여럿이면 message를 모은 CONFIG다. */
    private static function joined(array $errors): ?\Throwable
    {
        if (count($errors) <= 1) {
            return $errors[0] ?? null;
        }
        return new OrmException(Code::CONFIG, implode('; ', array_map(static fn(\Throwable $e): string => $e->getMessage(), $errors)), $errors[0]);
    }

    private function savepoint(TxFrame $frame, \Closure $fn): mixed
    {
        $name = 'orm_sp_' . (++$frame->savepoints);
        try {
            $this->run(StatementEvent::SAVEPOINT, [], $frame->number, "SAVEPOINT $name");
            self::$frames[] = $frame;
            try {
                $v = $fn();
            } catch (\Throwable $e) {
                array_pop(self::$frames);
                $failure = $e instanceof \PDOException ? $this->driverError($e) : $e;
                // savepoint 뒤의 작업을 되돌리고 savepoint를 푸는 두 statement를 모두 시도한다.
                $ended = self::joined(array_values(array_filter([
                    $this->endSavepoint($frame, StatementEvent::ROLLBACK_TO, "ROLLBACK TO SAVEPOINT $name"),
                    $this->endSavepoint($frame, StatementEvent::RELEASE, "RELEASE SAVEPOINT $name"),
                ])));
                throw $ended === null ? $failure : OrmException::rollback($failure, $ended);
            }
            array_pop(self::$frames);
            $released = $this->endSavepoint($frame, StatementEvent::RELEASE, "RELEASE SAVEPOINT $name");
            if ($released !== null) {
                throw $released;
            }
            return $v;
        } finally {
            $frame->savepoints--;
        }
    }

    /** savepoint를 끝내는 statement를 실행하고 실패하면 그 오류를 돌려준다. */
    private function endSavepoint(TxFrame $frame, string $kind, string $statement): ?\Throwable
    {
        try {
            $this->run($kind, [], $frame->number, $statement);
            return null;
        } catch (OrmException $e) {
            return $e;
        }
    }

    // ---- execution ----

    private function enter(?TxFrame $frame, array $ir): void
    {
        if ($this->closed) {
            throw new OrmException(Code::CONFIG, 'database is closed');
        }
        if ($frame !== null && $frame->finished) {
            throw new OrmException(Code::CONFIG, 'transaction already finished');
        }
        if (($ir['lock'] ?? '') !== '' && $frame === null) {
            throw new OrmException(Code::CONFIG, 'row locks are allowed only inside a transaction');
        }
    }

    private function plan(Request $r): array
    {
        // 연결은 자기에게 등록된 set만 plan한다. 요청이 실행될 수 있는 대상은 process가
        // 읽은 code가 아니라 연결이 쓰는 database가 정한다.
        $hash = $r->ir['manifest_hash'];
        if (!isset($this->sets[$hash])) {
            throw new OrmException(Code::SCHEMA_HASH_MISMATCH, "manifest $hash is not registered on this connection: connect through its generated code or install it");
        }
        $engine = Engine::for($hash, $this->driver, $this->config->planCacheSize);
        $shape = $r->shape();
        if (count($r->params) <= self::bindLimit($this->driver)) {
            return $engine->plan($shape);
        }
        // bind 한도보다 많은 값의 요청은 나뉜 요청(rootInParts)의 plan으로 실행된다.
        // 값마다 bind slot을 가진 이 plan은 수십 MB이므로 plan cache에 남기지 않는다.
        $plan = $engine->compile($shape);
        Assemble::index($plan, $engine->model);
        return $plan;
    }

    /** @internal @return array{0: array, 1: array} the plan and its positional result */
    public function select(?TxFrame $frame, Request $r): array
    {
        $this->enter($frame, $r->ir);
        $plan = $this->plan($r);
        $this->acquireSQLiteRowLock((string) ($r->ir['lock'] ?? ''));
        $parts = $this->rootInParts($r, $plan['steps'][0]);
        if ($parts !== []) {
            $main = [];
            $seen = [];
            foreach ($parts as $part) {
                $partPlan = $this->plan($part);
                foreach ($this->query($partPlan['steps'][0], $part->params) as $row) {
                    $key = self::rowKey($row, $partPlan['steps'][0]['assemble']['key']);
                    if (!isset($seen[$key])) {
                        $seen[$key] = true;
                        $main[] = $row;
                    }
                }
            }
        } else {
            $main = $this->query($plan['steps'][0], $r->params);
        }
        return [$plan, $this->relations($plan, $r->params, $main)];
    }

    /** @internal */
    public function scalarOf(?TxFrame $frame, Request $r): mixed
    {
        $this->enter($frame, $r->ir);
        $plan = $this->plan($r);
        $parts = $this->rootInParts($r, $plan['steps'][0]);
        if ($parts !== []) {
            if ($r->ir['kind'] !== 'count') {
                throw new OrmException(Code::IR_INVALID, 'a split IN list can be merged only for a count');
            }
            $total = 0;
            foreach ($parts as $part) {
                $total += (int) $this->scalar($this->plan($part)['steps'][0], $part->params);
            }
            return $total;
        }
        return $this->scalar($plan['steps'][0], $r->params);
    }

    /** @internal @return array{0: array, 1: array, 2: int} */
    public function paginate(?TxFrame $frame, Request $r): array
    {
        $this->enter($frame, $r->ir);
        $plan = $this->plan($r);
        $main = $this->query($plan['steps'][0], $r->params);
        $result = $this->relations($plan, $r->params, $main);
        foreach ($plan['steps'] as $st) {
            if (($st['role'] ?? '') === 'count') {
                return [$plan, $result, (int) $this->scalar($st, $r->params)];
            }
        }
        throw new OrmException(Code::INTERNAL, 'paginate plan has no count step');
    }

    /** @internal @return array{0: int|string|null, 1: int} the generated id and the affected rows */
    public function writeOf(?TxFrame $frame, Request $r): array
    {
        $this->enter($frame, $r->ir);
        $step = $this->plan($r)['steps'][0];
        $args = $this->args($step, $r->params, [], $frame);
        $insert = $r->ir['kind'] === 'insert';
        [$id, $affected] = $this->send(function () use ($step, $args, $insert, $r): array {
            $st = $this->stmt($step['sql']);
            try {
                $this->exec($st, $args);
                if ($insert && str_contains($step['sql'], ' RETURNING ')) {
                    $id = $st->fetchColumn();
                    $st->closeCursor();
                    return [$id, 1];
                }
                $entity = Registry::model($r->ir['manifest_hash'])->entity($r->ir['entity']);
                return [$insert && !isset($r->ir['rows']) && $entity['identity'] !== '' ? $this->handle()->lastInsertId() : null, $st->rowCount()];
            } catch (\PDOException $e) {
                throw self::failed($st, $e);
            }
        }, fn(int $start, ?OrmException $error) => $this->modelDone($step, $step['sql'], $args, $start, $error));
        if (isset($r->ir['optimistic']) && $affected === 0) {
            throw new OrmException(Code::OPTIMISTIC_LOCK, 'the row changed after it was read');
        }
        return [$id, $affected];
    }

    /** @internal @return array{sql: string, binds: list<mixed>} */
    public function statement(Request $r): array
    {
        $step = $this->plan($r)['steps'][0];
        $args = $this->args($step, $r->params);
        foreach ($this->masks as $i => $mask) {
            $args[$i] = $mask;
        }
        foreach ($args as $i => $v) {
            if ($v instanceof Bytes) {
                $args[$i] = $v->bytes;
            }
        }
        return ['sql' => $step['sql'], 'binds' => $args];
    }

    /** 'Y-m-d H:i:s'에 precision 자리의 소수를 붙인 text다. */
    private static function timeText(\DateTimeImmutable $t, int $precision): string
    {
        return $t->format('Y-m-d H:i:s') . ($precision > 0 ? '.' . substr($t->format('u'), 0, $precision) : '');
    }

    /**
     * datetime이나 date 값을 offset 없는 text로 쓴다. datetime은 UTC로 바꾸고
     * column precision 자리의 소수를 가지므로, SQLite에 저장된 text와 같고
     * MySQL과 PostgreSQL은 offset literal을 받지 않는다(docs/dialects.md). date는
     * 값의 달력 날짜다.
     */
    private function bindTimeValue(mixed $v, string $colType, int $precision): mixed
    {
        if ($v instanceof \DateTimeInterface) {
            return $colType === 'date'
                ? $v->format('Y-m-d')
                : self::timeText(\DateTimeImmutable::createFromInterface($v)->setTimezone($this->zone), $precision);
        }
        if (!is_string($v)) {
            return $v;
        }
        if ($colType === 'date') {
            $d = preg_match('/^\d{4}-\d{2}-\d{2}$/D', $v) === 1 ? \DateTimeImmutable::createFromFormat('!Y-m-d', $v) : false;
            if ($d === false || $d->format('Y-m-d') !== $v) {
                throw self::invalidTimeText($v, $colType);
            }
            return $v;
        }
        if (preg_match('/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})?$/D', $v, $m) !== 1) {
            throw self::invalidTimeText($v, $colType);
        }
        $fraction = $m[3] ?? '';
        $text = $m[1] . ' ' . $m[2] . '.' . str_pad($fraction, 6, '0');
        $zone = $m[4] ?? '';
        if ($zone === '') {
            $t = \DateTimeImmutable::createFromFormat('!Y-m-d H:i:s.u', $text);
            if ($t === false || $t->format('Y-m-d H:i:s.u') !== $text) {
                throw self::invalidTimeText($v, $colType);
            }
            return self::timeText($t, $precision);
        }
        $t = \DateTimeImmutable::createFromFormat('!Y-m-d H:i:s.uP', $text . ($zone === 'Z' ? '+00:00' : $zone));
        if ($t === false || $t->format('Y-m-d H:i:s.u') !== $text) {
            throw self::invalidTimeText($v, $colType);
        }
        return self::timeText($t->setTimezone($this->zone), $precision);
    }

    private static function invalidTimeText(string $v, string $colType): OrmException
    {
        $form = $colType === 'date' ? 'YYYY-MM-DD' : 'YYYY-MM-DD HH:MM:SS[.ffffff][Z|±HH:MM]';
        return new OrmException(Code::CODEC_ENCODE, "$colType value \"$v\" is not $form");
    }

    private function args(array $step, array $params, array $parentVals = [], ?TxFrame $frame = null): array
    {
        $out = [];
        $this->masks = [];
        $this->typed = $this->driver === 'sqlite';
        $cfg = $this->config;
        // One statement reads the clock once, so its clock columns are equal.
        /** @var ?\DateTimeImmutable $clock */
        $clock = null;
        foreach ($step['bind_slots'] ?? [] as $b) {
            switch ($b['from']) {
                case 'parent':
                    foreach ($parentVals as $v) {
                        $out[] = $v;
                    }
                    break;
                case 'param':
                    $v = $params[$b['param']];
                    $colType = $b['col_type'] ?? '';
                    if (($colType === 'datetime' || $colType === 'date') && $v !== null) {
                        $v = $this->bindTimeValue($v, $colType, $b['precision'] ?? 0);
                    }
                    if ($colType === 'decimal' && $v !== null) {
                        if (!is_string($v)) {
                            throw new OrmException(Code::CODEC_ENCODE, 'decimal bind requires exact text');
                        }
                        $v = $this->driver === 'sqlite'
                            ? Decimal::scaled($v, $b['precision'], $b['scale'])
                            : Decimal::normalize($v, $b['precision'], $b['scale']);
                    }
                    if ($v instanceof \DateTimeInterface) {
                        $v = \DateTimeImmutable::createFromInterface($v)->setTimezone($this->zone)->format('Y-m-d H:i:s.u');
                    }
                    if (($b['transform'] ?? '') !== '') {
                        $v = Transform::apply($b['transform'], (string) $v);
                    } elseif (in_array('blind_index', $b['host_styles'] ?? [], true)) {
                        $v = Codec::blindIndex($v, $cfg->blindIndexKey);
                    } elseif (!empty($b['host_styles'])) {
                        $v = Codec::hostEncode($v, $b['host_styles'], $cfg->aesKey);
                        $this->typed = $this->typed || $v instanceof Bytes;
                    } elseif (is_bool($v) || $v instanceof Bytes) {
                        $this->typed = true;
                    }
                    $out[] = $v;
                    break;
                case 'secret':
                    if (($b['name'] ?? '') !== 'aes' || $cfg->aesKey === '') {
                        throw new OrmException(Code::CONFIG, "secret {$b['name']} is not configured");
                    }
                    $this->masks[count($out)] = self::SECRET;
                    $out[] = $cfg->aesKey;
                    break;
                case 'config':
                    if (($b['name'] ?? '') !== 'aes_version') {
                        throw new OrmException(Code::CONFIG, "config value {$b['name']} is not configured");
                    }
                    $out[] = $cfg->aesVersion;
                    break;
                case 'now':
                    $this->masks[count($out)] = self::NOW;
                    $clock ??= new \DateTimeImmutable('now', $this->zone);
                    // 한 statement는 clock을 한 번 읽고 slot의 소수 자리로 자른다.
                    $out[] = self::timeText($clock, $b['precision']);
                    break;
                case 'audit':
                    $audit = $frame?->audit ?? throw new OrmException(Code::CONFIG, 'a write of an audited table needs an audit: run it in a transaction with audit values');
                    if ($audit['table'] !== ($b['name'] ?? '')) {
                        throw new OrmException(Code::CONFIG, "the audited table records its audits in {$b['name']}, but the audit of the transaction is a row of {$audit['table']}");
                    }
                    $out[] = $audit['key'];
                    break;
                default:
                    throw new OrmException(Code::INTERNAL, "bind from {$b['from']}");
            }
        }
        return $out;
    }

    /**
     * Binds with types where the driver needs them: MySQL bools as 0/1,
     * PostgreSQL bools and binary values, SQLite ints, bools, blobs, and nulls.
     */
    private function exec(\PDOStatement $st, array $args): void
    {
        if (!$this->typed) {
            $st->execute($args);
            return;
        }
        if ($this->driver === 'mysql') {
            foreach ($args as $i => $v) {
                if (is_bool($v)) {
                    $args[$i] = (int) $v;
                } elseif ($v instanceof Bytes) {
                    $args[$i] = $v->bytes;
                }
            }
            $st->execute($args);
            return;
        }
        $pg = $this->driver === 'postgres';
        foreach ($args as $i => $v) {
            if (is_bool($v)) {
                $pg ? $st->bindValue($i + 1, $v, \PDO::PARAM_BOOL) : $st->bindValue($i + 1, (int) $v, \PDO::PARAM_INT);
            } elseif ($v instanceof Bytes) {
                $st->bindValue($i + 1, $v->bytes, \PDO::PARAM_LOB);
            } elseif ($v === null) {
                $st->bindValue($i + 1, null, \PDO::PARAM_NULL);
            } elseif (is_int($v) && !$pg) {
                $st->bindValue($i + 1, $v, \PDO::PARAM_INT);
            } else {
                $st->bindValue($i + 1, is_string($v) ? $v : (string) $v);
            }
        }
        $st->execute();
    }

    /** 실패한 statement의 cursor를 닫고 그 driver 오류를 돌려준다. */
    private static function failed(\PDOStatement $st, \PDOException $e): \PDOException
    {
        try {
            $st->closeCursor();
        } catch (\PDOException) {
            // the reset reports the failed step again on some drivers
        }
        return $e;
    }

    /**
     * model statement의 event를 publish한다. kind는 plan step SQL의 첫 단어, tables는 plan
     * step의 table이다. bind는 비밀과 시각 slot을 가린 값이다.
     */
    private function modelDone(array $step, string $sql, array $args, int $start, ?OrmException $err): void
    {
        foreach ($this->masks as $i => $mask) {
            $args[$i] = $mask;
        }
        $this->publish(self::statementKind($step['sql']), $step['tables'], $this->transactionNumber(), $sql, $args, $start, $err);
    }

    /** planner가 쓴 statement의 kind다: SQL의 첫 단어다. */
    private static function statementKind(string $sql): string
    {
        return match (strtoupper(explode(' ', ltrim($sql), 2)[0])) {
            'INSERT' => StatementEvent::INSERT,
            'UPDATE' => StatementEvent::UPDATE,
            'DELETE' => StatementEvent::DELETE,
            default => StatementEvent::SELECT,
        };
    }

    /** @internal takes the ORM lock row that stands for SQLite row locks */
    public function acquireSQLiteRowLock(string $mode): void
    {
        if ($mode === '' || $this->driver !== 'sqlite') {
            return;
        }
        $tx = $this->transactionNumber();
        $noWait = str_ends_with($mode, '_nowait');
        $previous = 0;
        if ($noWait) {
            $previous = (int) ($this->fetch(StatementEvent::UTILITY, [], $tx, 'PRAGMA busy_timeout')[0][0] ?? 0);
            $this->run(StatementEvent::UTILITY, [], $tx, 'PRAGMA busy_timeout=0');
        }
        try {
            $this->ensureRowLockTable();
            $this->run(StatementEvent::UTILITY, [self::ROW_LOCK_TABLE], $tx, 'INSERT INTO "orm__row_lock" ("id") VALUES (1) ON CONFLICT ("id") DO UPDATE SET "id"=excluded."id"');
        } catch (OrmException $e) {
            $driverError = $e->getPrevious();
            if ($noWait && $driverError instanceof \PDOException && (((int) ($driverError->errorInfo[1] ?? 0)) & 0xff) === 5) {
                throw new OrmException(Code::LOCK_NOT_AVAILABLE, $driverError->getMessage(), $driverError);
            }
            throw $e;
        } finally {
            if ($noWait) {
                $this->run(StatementEvent::UTILITY, [], $tx, 'PRAGMA busy_timeout=' . $previous);
            }
        }
    }

    /** @return list<list<mixed>> positional rows with styled cells decoded */
    private function query(array $step, array $params, ?string $sql = null, array $parentVals = []): array
    {
        $sql ??= $step['sql'];
        $args = $this->args($step, $params, $parentVals);
        $rows = $this->send(function () use ($sql, $args): array {
            $st = $this->stmt($sql);
            try {
                $this->exec($st, $args);
                $rows = $st->fetchAll(\PDO::FETCH_NUM);
                $st->closeCursor();
                return $rows;
            } catch (\PDOException $e) {
                throw self::failed($st, $e);
            }
        }, fn(int $start, ?OrmException $error) => $this->modelDone($step, $sql, $args, $start, $error));
        // 읽은 행을 풀지 못한 오류는 statement의 오류가 아니므로 event 뒤에 던진다.
        if ($step['decode'] !== []) {
            Codec::decodeRows($rows, $step['decode'], $this->config);
        }
        return $rows;
    }

    private function scalar(array $step, array $params): mixed
    {
        $args = $this->args($step, $params);
        $v = $this->send(function () use ($step, $args): mixed {
            $st = $this->stmt($step['sql']);
            try {
                $this->exec($st, $args);
                $v = $st->fetchColumn();
                $st->closeCursor();
                return $v;
            } catch (\PDOException $e) {
                throw self::failed($st, $e);
            }
        }, fn(int $start, ?OrmException $error) => $this->modelDone($step, $step['sql'], $args, $start, $error));
        return $v === false ? null : $v;
    }

    /** @return array{main: list<list<mixed>>, steps: array<int, array>, params: list<mixed>} */
    private function relations(array $plan, array $params, array $main): array
    {
        $out = ['main' => $main, 'steps' => [], 'params' => $params];
        foreach ($plan['steps'] as $st) {
            if (($st['role'] ?? '') !== 'relation') {
                continue;
            }
            $pr = $st['parent'];
            $parents = $pr['step'] === 0 ? $main : $out['steps'][$pr['step']]['data'];
            $vals = self::parentValues($pr, $parents, $params);
            $sr = ['step' => $st, 'data' => [], 'byKey' => []];
            if ($vals !== []) {
                foreach (self::relationChunks($st, $vals, $this->driver) as $chunk) {
                    [$sql, $chunk] = self::expandIn($st, $chunk);
                    array_push($sr['data'], ...$this->query($st, $params, $sql, $chunk));
                }
                $keys = self::childKeys($plan, $st['id']);
                foreach ($sr['data'] as $j => $row) {
                    $key = self::rowKey($row, $keys);
                    if ($key !== null) {
                        $sr['byKey'][$key][] = $j;
                    }
                }
            }
            $out['steps'][$st['id']] = $sr;
        }
        return $out;
    }

    private static function parentValues(array $pr, array $parents, array $params): array
    {
        $seen = [];
        $out = [];
        $ifp = $pr['if_parent'] ?? null;
        foreach ($parents as $row) {
            if ($ifp !== null && !self::sameScalar($row[$ifp['index']], $params[$ifp['param']])) {
                continue;
            }
            $key = self::rowKey($row, $pr['keys']);
            if ($key === null || isset($seen[$key])) {
                continue;
            }
            $seen[$key] = true;
            foreach ($pr['keys'] as $ref) {
                $out[] = $row[$ref['index']];
            }
        }
        return $out;
    }

    /**
     * Rewrites the single parent placeholder into a list padded to a power of
     * two. On PostgreSQL every later placeholder number shifts.
     * @return array{0: string, 1: list<mixed>}
     */
    private static function expandIn(array $step, array $vals): array
    {
        $width = count($step['parent']['keys']);
        $tuples = intdiv(count($vals), $width);
        $n = 1;
        while ($n < $tuples) {
            $n <<= 1;
        }
        $last = array_slice($vals, ($tuples - 1) * $width, $width);
        while (count($vals) < $n * $width) {
            array_push($vals, ...$last);
        }
        $src = $step['sql'];
        if (str_contains($src, '$1')) {
            $parent = -1;
            foreach ($step['bind_slots'] as $i => $b) {
                if ($b['from'] === 'parent') {
                    $parent = $i + 1;
                }
            }
            $sql = preg_replace_callback('/\$(\d+)/', static function (array $m) use ($parent, $n, $width): string {
                $k = (int) $m[1];
                if ($k === $parent) {
                    $groups = [];
                    for ($t = 0; $t < $n; $t++) {
                        $parts = [];
                        for ($p = 0; $p < $width; $p++) {
                            $parts[] = '$' . ($k + $t * $width + $p);
                        }
                        $groups[] = implode(', ', $parts);
                    }
                    return implode($width === 1 ? ', ' : '), (', $groups);
                }
                return $k > $parent ? '$' . ($k + $n * $width - 1) : $m[0];
            }, $src);
            return [$sql, $vals];
        }
        $sql = '';
        $slot = 0;
        for ($i = 0, $len = strlen($src); $i < $len; $i++) {
            if ($src[$i] !== '?') {
                $sql .= $src[$i];
                continue;
            }
            if ($step['bind_slots'][$slot]['from'] === 'parent') {
                $sql .= implode($width === 1 ? ', ' : '), (', array_fill(0, $n, implode(', ', array_fill(0, $width, '?'))));
            } else {
                $sql .= '?';
            }
            $slot++;
        }
        return [$sql, $vals];
    }

    private static function relationChunks(array $step, array $vals, string $driver): array
    {
        $width = count($step['parent']['keys']);
        $nonParent = count(array_filter($step['bind_slots'] ?? [], static fn(array $b): bool => $b['from'] !== 'parent'));
        $maxTuples = intdiv(self::bindLimit($driver) - $nonParent, $width);
        if ($maxTuples < 1) {
            throw new OrmException(Code::IR_INVALID, "relation {$step['id']} needs more bind parameters than $driver permits");
        }
        $chunk = 1;
        while ($chunk * 2 <= $maxTuples) {
            $chunk *= 2;
        }
        return array_chunk($vals, $chunk * $width);
    }

    private static function childKeys(array $plan, int $id): array
    {
        $find = function (array $a) use (&$find, $id): ?array {
            foreach ($a['children'] ?? [] as $ch) {
                if ($ch['kind'] !== 'join' && $ch['step'] === $id) {
                    return $ch['child_keys'];
                }
                if ($ch['kind'] === 'join' && ($keys = $find($ch['assemble'])) !== null) {
                    return $keys;
                }
            }
            return null;
        };
        foreach ($plan['steps'] as $st) {
            if (isset($st['assemble']) && ($keys = $find($st['assemble'])) !== null) {
                return $keys;
            }
        }
        throw new OrmException(Code::INTERNAL, "relation step $id without a child");
    }

    /**
     * Splits a root IN list that exceeds the driver bind limit into requests
     * whose results together equal the original result.
     * @return list<Request>
     */
    private function rootInParts(Request $r, array $step): array
    {
        $limit = self::bindLimit($this->driver);
        if (count($step['bind_slots'] ?? []) <= $limit) {
            return [];
        }
        $tooLarge = new OrmException(Code::IR_INVALID, 'the statement needs ' . count($step['bind_slots']) . " bind parameters but {$this->driver} permits $limit");
        $ir = $r->ir;
        $items = $ir['where']['items'] ?? [];
        if (isset($ir['limit']) || isset($ir['order']) || isset($ir['group_by']) || $items === []) {
            throw $tooLarge;
        }
        $target = -1;
        foreach ($items as $i => $item) {
            if (!isset($item['pred'])) {
                continue;
            }
            $next = $items[$i + 1] ?? null;
            $nextConn = $next === null ? '' : (reset($next)['conn'] ?? '');
            if (($item['pred']['conn'] ?? '') === 'or' || $nextConn === 'or') {
                throw $tooLarge;
            }
            if ($item['pred']['op'] === 'in' && !isset($item['pred']['sub']) && ($target < 0 || count($item['pred']['ps']) > count($items[$target]['pred']['ps']))) {
                $target = $i;
            }
        }
        if ($target < 0) {
            throw $tooLarge;
        }
        $ps = $items[$target]['pred']['ps'];
        $available = $limit - (count($step['bind_slots']) - count($ps));
        if ($available < 1) {
            throw $tooLarge;
        }
        $chunk = 1;
        while ($chunk * 2 <= $available) {
            $chunk *= 2;
        }
        $seen = [];
        $unique = [];
        foreach ($ps as $p) {
            $k = self::scalarText($r->params[$p]);
            if (!isset($seen[$k])) {
                $seen[$k] = true;
                $unique[] = $p;
            }
        }
        $parts = [];
        foreach (array_chunk($unique, $chunk) as $group) {
            $part = clone $r;
            $part->ir['where']['items'][$target]['pred']['ps'] = Request::padIn($group);
            $parts[] = $part;
        }
        return $parts;
    }

    /** @param list<mixed> $row @param list<array{column:string,index:int}> $refs */
    public static function rowKey(array $row, array $refs): int|string|null
    {
        if (count($refs) === 1) {
            $v = $row[$refs[0]['index']];
            return $v === null ? null : Collection::keyOf($v);
        }
        $out = '';
        foreach ($refs as $ref) {
            $v = $row[$ref['index']];
            if ($v === null) {
                return null;
            }
            $part = self::scalarText($v);
            $out .= strlen($part) . ':' . $part;
        }
        return $out;
    }

    public static function sameScalar(mixed $a, mixed $b): bool
    {
        return self::scalarText($a) === self::scalarText($b);
    }

    public static function scalarText(mixed $v): string
    {
        return match (true) {
            $v === null => "\0",
            is_bool($v) => $v ? '1' : '0',
            $v instanceof \DateTimeInterface => $v->format('Y-m-d H:i:s.u'),
            default => (string) $v,
        };
    }
}

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

final class Transform
{
    /** Executor-side value transforms, identical in every client. */
    public static function apply(string $kind, string $s): string
    {
        switch ($kind) {
            case 'like_contains':
                return '%' . self::esc($s) . '%';
            case 'like_starts':
                return self::esc($s) . '%';
            case 'like_ends':
                return '%' . self::esc($s);
        }
        return $s;
    }

    private static function esc(string $s): string
    {
        return str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $s);
    }
}
