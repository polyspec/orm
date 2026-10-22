<?php

// Conformance runner (PHP). Runs the chains of packages/go/internal/conformance/main.go and prints the same document.
// Usage: php packages/php/testing/conformance/runner.php --dsn URI [--vector NAME]...
// --vector can be repeated; when given, only the vectors with that name run. An unknown name is an error.
declare(strict_types=1);

require dirname(__DIR__, 2) . '/tests/autoload.php';
require __DIR__ . '/result_php_helpers.php';
require dirname(__DIR__, 2) . '/testing/Faults.php';

use Polyspec\Orm\Tests\Model\AuditRecord;
use Polyspec\Orm\Tests\Model\AuditedNote;
use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Tests\Model\BindCell;
use Polyspec\Orm\Tests\Model\ClockCell;
use Polyspec\Orm\Tests\Model\CompositeAccount;
use Polyspec\Orm\Tests\Model\HexCell;
use Polyspec\Orm\Tests\Model\NoteReader;
use Polyspec\Orm\Tests\Model\SharedNote;
use Polyspec\Orm\Tests\Model\DayCell;
use Polyspec\Orm\Tests\Model\TimeCell;
use Polyspec\Orm\Tests\Model\Service;
use Polyspec\Orm\Tests\Model\ServiceMember;
use Polyspec\Orm\Tests\Model\ServiceRegion;
use Polyspec\Orm\Tests\Model\SoftLink;
use Polyspec\Orm\Tests\Model\SoftRecord;
use Polyspec\Orm\Tests\Model\Task;
use Polyspec\Orm\Tests\Model\UpsertCell;
use Polyspec\Orm\Tests\Model\User;
use Polyspec\Orm\Tests\Model\UuidCell;
use Polyspec\Orm\AesKeyring;
use Polyspec\Orm\Db;
use Polyspec\Orm\Collection;
use Polyspec\Orm\Config;
use Polyspec\Orm\Model;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\StatementEvent;
use Polyspec\Orm\StyledValue;
use Polyspec\Orm\Testing\Faults;

$dsn = null;
$selected = [];
for ($i = 1; $i < $argc; $i++) {
    $flag = $argv[$i];
    if (($flag === '--dsn' || $flag === '--vector') && $i + 1 >= $argc) {
        throw new RuntimeException("$flag needs a value");
    }
    match ($flag) {
        '--dsn' => $dsn = $argv[++$i],
        '--vector' => isset($selected[$argv[++$i]]) ? throw new RuntimeException(
            "duplicate --vector {$argv[$i]}"
        ) : $selected[$argv[$i]] = true,
        default => throw new RuntimeException("unknown argument $flag"),
    };
}
$dsn ?? throw new RuntimeException('--dsn required');

// $log is the vector's statement events (docs/operations/usage.md "Statement events"). A transaction's number within
// the vector is renumbered from 1 in order of first appearance, and is null outside. error is the statement's error
// code or null.
$log = [];
/** @var array<int, int> Maps transaction numbers in the vector to numbers in order of first appearance. */
$transactions = [];
$maskSeqs = [];
$maskTs = [];

/** Renders a bound value the way every runner does. */
function norm(mixed $v): mixed
{
    global $maskSeqs, $maskTs;
    if (is_int($v)) {
        return isset($maskSeqs[$v]) ? '$SEQ' : $v;
    }
    if (is_string($v)) {
        if (isset($maskTs[$v])) {
            return '$TS';
        }
        if (str_starts_with($v, "ORM-AES2\0")) {
            if (strlen($v) < 9 + 12 + 16) {
                throw new RuntimeException('invalid AES ciphertext bind');
            }
            return '$AES';
        }
        if (str_starts_with($v, 'ORM-AES2')) {
            throw new RuntimeException('invalid AES ciphertext bind');
        }
        if (str_starts_with(strtolower($v), '4f524d2d41455332')) {
            $decoded = hex2bin($v);
            if ($decoded === false || !str_starts_with($decoded, "ORM-AES2\0") || strlen($decoded) < 9 + 12 + 16) {
                throw new RuntimeException('invalid hex AES ciphertext bind');
            }
            return '$AES';
        }
    }
    return $v;
}

/** Masks the keys and update times of rows a vector created, including statements logged earlier. */
function mask(array $seqs, array $times = []): void
{
    global $log, $maskSeqs, $maskTs;
    foreach ($seqs as $s) {
        $maskSeqs[$s] = true;
    }
    foreach ($times as $t) {
        $maskTs[$t->format('Y-m-d H:i:s.u')] = true;
    }
    foreach ($log as &$st) {
        $st['binds'] = array_map('norm', $st['binds']);
    }
}

function code(?Throwable $e): mixed
{
    if ($e === null) {
        return null;
    }
    return $e instanceof OrmException ? $e->code_ : $e->getMessage();
}

function caught(callable $fn): mixed
{
    try {
        $fn();
    } catch (Throwable $e) {
        return code($e);
    }
    return null;
}

function pick(?Model $m, string ...$names): ?array
{
    if ($m === null) {
        return null;
    }
    $all = $m->toArray();
    $out = [];
    foreach ($names as $n) {
        if (!array_key_exists($n, $all)) {
            throw new RuntimeException("missing selected field: $n");
        }
        $out[$n] = $all[$n];
    }
    return $out;
}

// dateOnly writes a date cell as its YYYY-MM-DD text, the form every other runner returns for a date column.
function dateOnly(array $rows): array
{
    foreach ($rows as $i => $row) {
        if ($row === null) {
            continue;
        }
        if ($row['day'] instanceof DateTimeInterface) {
            $rows[$i]['day'] = $row['day']->format('Y-m-d');
        } elseif (is_string($row['day']) && preg_match('/^\d{4}-\d{2}-\d{2} /', $row['day']) === 1) {
            $rows[$i]['day'] = substr($row['day'], 0, 10);
        }
    }
    return $rows;
}

function picks(Collection $c, string ...$names): array
{
    return array_map(static fn(Model $m): ?array => pick($m, ...$names), $c->all());
}

$db = \Polyspec\Orm\Tests\Model\connect($dsn, new Config(
    aesKey: 'bench-salt',
    blindIndexKey: 'bench-blind-index',
    auditSource: static fn(): array => [],
));
$db->subscribe(static function (StatementEvent $e): void {
    global $log, $transactions;
    $transaction = null;
    if ($e->transaction !== null) {
        $transactions[$e->transaction] ??= count($transactions) + 1;
        $transaction = $transactions[$e->transaction];
    }
    $log[] = [
        'sql' => $e->sql,
        'binds' => array_map('norm', $e->binds),
        'kind' => $e->kind,
        'tables' => $e->tables,
        'transaction' => $transaction,
        'error' => $e->error?->code_,
    ];
});

$out = [];
/** @var array<string, callable> Chain per vector name, in declaration order */
$vectors = [];
$writeVectors = array_fill_keys(
    [
        'write_cycle',
        'now_defaults',
        'required_columns',
        'creates_and_save',
        'delete_recursive',
        'contains_ascii_fold',
        'contains_binary_code_point',
        'datetime_p0_roundtrip',
        'time_p3_roundtrip',
        'date_roundtrip',
        'date_null',
        'upsert_one_key',
        'affected_counts',
        'uuid_roundtrip',
        'clock_truncate_write',
        'clock_compare_six_digits'
    ],
    true
);

/** Declares a vector. The selected vectors run in declaration order after all declarations are done. */
function vector(string $name, callable $fn): void
{
    global $vectors;
    if (isset($vectors[$name])) {
        throw new RuntimeException("duplicate vector $name");
    }
    $vectors[$name] = $fn;
}

function run(string $name, callable $fn): void
{
    global $out, $log, $transactions, $maskSeqs, $maskTs, $db, $writeVectors;
    $log = [];
    $transactions = [];
    $maskSeqs = [];
    $maskTs = [];
    $res = executeVector(
        $name,
        $fn,
        isset($writeVectors[$name]) ? static fn(callable $task): mixed => $db->transaction($task, retry: 0) : null
    );
    $out[$name] = ['statements' => $log, 'result' => $res];
}

$author = static fn(): Author => (new Author())->connect($db);
$cols = ['seq', 'name', 'is_close', 'is_display', 'read_count'];

vector(
    'conditions_connectors',
    fn() => picks(
        $author()->serviceSeq(7)->andIsClose(false)->or()->readCount(6)->orderBySeqAsc()->limit(0, 3)->gets(),
        ...$cols
    )
);

vector('conditions_group', fn() => picks($author()->serviceSeq(7)
    ->and(fn(Author $q) => $q->isDisplay(false)->or(fn(Author $q) => $q->isClose(true)->andGtReadCount(500)))
    ->orderBySeqDesc()->limit(0, 3)->gets(), ...$cols));

vector('conditions_leading_group', fn() => picks($author()
    ->and(fn(Author $q) => $q->isDisplay(false)->orIsClose(true))
    ->andServiceSeq(7)
    ->orderBySeqDesc()->limit(0, 3)->gets(), ...$cols));

vector('conditions_leading_prefix', fn() => picks($author()->andServiceSeq(7)->andGtReadCount(990)
    ->orderBySeqDesc()->limit(0, 3)->gets(), ...$cols));

vector('conditions_values', fn() => array_map(static fn(Author $q): int => $q->getCount(), [
    $author()->serviceSeq([7, 8])->andNeIsClose(true),
    $author()->serviceSeq(7)->andUuid(null),
    $author()->serviceSeq(7)->andNePhotoUrl(null),
    $author()->serviceSeq(7)->andNeReadCount([6, 106, 206]),
    $author()->serviceSeq(7)->andBetweenReadCount([100, 200]),
    $author()->serviceSeq(7)->andLkName('uthor-10'),
    $author()->serviceSeq(7)->andLbName('Author-10'),
    $author()->serviceSeq(7)->andGeReadCount(990),
    $author()->serviceSeq(7)->andLeReadCount(10),
    $author()->serviceSeq(7)->andLtSeq(1000),
]));

vector('terminal_by', function () use ($author, $cols): array {
    $one = $author()->getBySeq(42);
    $missing = caught(fn() => $author()->getBySeq(-1));
    $rows = $author()->orderBySeqAsc()->limit(0, 2)->getsByServiceSeqAndIsClose(7, false);
    $count = $author()->getCountByServiceSeq(7);
    return ['one' => pick($one, ...$cols), 'missing' => $missing, 'rows' => picks($rows, ...$cols), 'count' => $count];
});

vector('terminal_reuse', function () use ($author): array {
    $q = $author()->serviceSeq(7)->orderBySeqAsc()->limit(0, 2);
    $first = $q->getCountByIsClose(true);
    $rows = $q->gets();
    return [$first, count($rows), $q->getCount()];
});

vector('expression_forms', fn() => [
    'count' => $author()->serviceSeq(7)->andNot(fn(Author $q) => $q->isClose(true)->orGtReadCount(500))->getCount(),
    'rows' => picks(
        $author()->not(fn(Author $q) => $q->isDisplay(false))->andServiceSeq(7)->orderBySeqDesc()->limit(0, 3)->gets(),
        'seq',
        'is_display'
    ),
    'or_count' => $author()->serviceSeq(7)->orNot(fn(Author $q) => $q->ltReadCount(990))->getCount(),
]);

vector('columns', function () use ($db, $author): array {
    $none = (new Service())($db)->removeAllColumns()->getBySeq(7);
    $added = $author()->removeAllColumns()->addColumnName()->addColumnStartDtAliasStartYear(Orm::year())->getBySeq(42);
    $removed = (new Service())($db)->removeColumnName()->getBySeq(7);
    return [$none->toArray(), pick($added, 'seq', 'name', 'start_year'), $removed->toArray()];
});

vector('joins', function () use ($author): array {
    $service = (new Service())->on(fn(Service $s) => $s->gtSeq(0))->name('service-7');
    $rows = $author()
        ->removeAllColumns()->addColumnName()
        ->joinServiceSeqWithSeq($service)
        ->isClose(false)
        ->and(fn(Author $q) => $q->isDisplay(true)->or($service))
        ->orderBySeqAsc()->limit(0, 2)->gets();
    $member = new ServiceMember();
    $compared = $author()->joinServiceMemberSeqWithSeq($member)
        ->serviceSeq(7)
        ->andSuccessCountLtSeq($member)
        ->getCount();
    $left = $author()->leftJoinServiceRegionSeqWithSeq((new ServiceRegion())->aliasModule())
        ->serviceSeq(7)
        ->orderBySeqAsc()
        ->limit(0, 1)
        ->gets();
    return [
        'rows' => $rows->toArray(),
        'compared' => $compared,
        'module' => pick($left->first()->getModule(), 'seq', 'name')
    ];
});

vector('relations', fn() => $author()
    ->removeAllColumns()->addColumnName()->addColumnIsClose()
    ->relation((new User())->matchUserSeqWithSeq()->aliasWriter()
        ->relations((new Author())->matchSeqWithUserSeq()->removeAllColumns()->orderBySeqDesc()->groupLimit(2)))
    ->relation((new Service())->matchServiceSeqWithSeq()
        ->relations(
            (new ServiceMember())->matchSeqWithServiceSeq()
                ->removeAllColumns()
                ->orderBySeqAsc()
                ->groupLimit(2)
                ->keyNameUserSeq()
        ))
    ->relation((new ServiceRegion())->matchServiceRegionSeqWithSeq()->possibleIsClose(true)->parentNode())
    ->serviceSeq(7)->orderBySeqAsc()->limit(0, 3)->gets()->toArray());

vector(
    'relation_empty',
    fn() => count($author()->relations((new ServiceMember())->matchUserSeqWithUserSeq())->getsBySeq(-1))
);
vector('relation_null_key', function () use ($db): int|array {
    try {
        return count(
            (new User())($db)->relations((new Author())->matchSeqWithUserSeq()->keyNamePrice())->seq(100)->gets()
        );
    } catch (OrmException $e) {
        // a nullable key_by is refused by the engine (IR_INVALID): that refusal is the result, not a crash.
        return ['error' => 'IR_INVALID', 'message' => $e->getMessage()];
    }
});

// shared_note is a table of the external document bench_shared: it is read through its entity, and a write fails
// with CONFIG before any statement (docs/spec/dbspec.md "External documents").
vector('external_read', function () use ($db): array {
    $related = array_map(
        static fn(NoteReader $r): array => [$r->getSeq(), $r->getSharedNoteModel()->getTitle()],
        (new NoteReader())($db)->relation((new SharedNote())->matchSharedNoteSeqWithSeq())
            ->orderBySeqAsc()
            ->gets()
            ->all(),
    );
    $titles = array_map(
        static fn(SharedNote $n): string => $n->getTitle(),
        (new SharedNote())($db)->seq((new NoteReader())->addColumnSharedNoteSeq())->orderBySeqAsc()->gets()->all(),
    );
    $write = null;
    try {
        (new SharedNote())($db)->setSeq(9)->setTitle('written')->create();
    } catch (Throwable $e) {
        $write = code($e);
    }
    return ['relation' => $related, 'subquery' => $titles, 'write' => $write];
});

vector('subqueries', fn() => array_map(
    static fn(User $u): array => [$u->getSeq(), derivedInteger($u->getReadTotal())],
    (new User())($db)
        ->addColumnReadTotal(fn(User $u) => (new Author())->sumReadCount()->userSeqEqSeq($u)->andServiceSeq(7))
        ->seq((new Author())->addColumnUserSeq()->serviceSeq(7)->andGeReadCount(906))
        ->orderBySeqAsc()->gets()->all(),
));

vector('aggregates', function () use ($author): array {
    $sum = $author()->serviceSeq(7)->sumReadCount()->getSum();
    $avg = $author()->serviceSeq(7)->avgLikeCount()->getAvg();
    if (bin2hex(pack('E', $avg)) !== '404805c28f5c28f6') {
        throw new RuntimeException("aggregate average has unexpected binary64 value: {$avg}");
    }
    $groups = $author()->serviceSeq(7)->groupByIsClose()->orderByIsCloseAsc()->getsCount();
    $page = $author()->serviceSeq(7)->removeAllColumns()->orderBySeqAsc()->getsPage(3, 4);
    return [
        'sum' => $sum,
        'avg' => sprintf('%.4f', $avg),
        'groups' => $groups->toArray(),
        'page' => [
            'keys' => $page->items->keys(),
            'total' => $page->totalCount,
            'pages' => $page->totalPages,
            'page' => $page->page,
            'per_page' => $page->perPage
        ],
    ];
});

vector('empty_reads', function () use ($author): array {
    // The reads run in the order of the other runners, so the statements agree.
    $get = $author()->seq(-1)->get();
    $getBy = $author()->getBySeq(-1);
    $gets = count($author()->seq(-1)->gets());
    $groups = $author()->seq(-1)->groupByIsClose()->getsCount()->toArray();
    $page = $author()->seq(-1)->removeAllColumns()->orderBySeqAsc()->getsPage(1, 10);
    return [
        'get' => $get,
        'get_by' => $getBy,
        'gets' => $gets,
        'gets_count' => $groups,
        'page' => [
            'items' => count($page->items),
            'total_count' => $page->totalCount,
            'total_pages' => $page->totalPages,
            'page' => $page->page,
            'per_page' => $page->perPage
        ],
        'count' => $author()->seq(-1)->getCount(),
        'sum' => $author()->seq(-1)->sumReadCount()->getSum(),
        'avg' => $author()->seq(-1)->avgLikeCount()->getAvg(),
        'null_rows' => $author()->price(null)->getCount(),
        'null_sum' => $author()->price(null)->sumPrice()->getSum(),
        'null_avg' => $author()->price(null)->avgPrice()->getAvg(),
    ];
});

vector('audit_lazy', function () use ($db): array {
    // An audited transaction inserts its audit record right before its first write of an audited table:
    // reads and an update that matches no row leave no record, and the create inserts one. The transaction
    // is rolled back at the end, so the database is the same as at the start.
    $boom = new RuntimeException('boom');
    $result = [];
    $caught = null;
    try {
        $db->transaction(function () use ($boom, &$result): void {
            $result['before'] = (new AuditRecord())->getCount();
            $result['read'] = (new AuditedNote())->label('audit-lazy')->getCount();
            (new AuditedNote())->setSeq(-1)->setLabel('audit-none')->update();
            $result['unchanged'] = (new AuditRecord())->getCount();
            $created = (new AuditedNote())->setLabel('audit-lazy')->create();
            mask([$created->getSeq()]);
            $result['written'] = (new AuditRecord())->getCount();
            throw $boom;
        }, retry: 0, audit: ['request_id' => 'audit-lazy']);
    } catch (\Throwable $e) {
        $caught = $e;
    }
    $result['rolled_back'] = $caught === $boom;
    $result['after'] = (new AuditRecord())($db)->getCount();
    return $result;
});

vector('functions', function () use ($author): array {
    $counts = array_map(static fn(Author $q): int => $q->getCount(), [
        $author()->serviceSeq(7)->andEqStartDt(Orm::dayOfWeek(), 2),
        $author()->serviceSeq(7)->andStartDt(Orm::year(), 2026),
        $author()->serviceSeq(7)->andGtStartDt(Orm::daysAgo(36500)),
        $author()->serviceSeq(7)->andLtStartDt(Orm::monthsLater(1200)),
    ]);
    $rows = $author()->removeAllColumns()->addColumnStartDtAliasStartMonth(Orm::month())
        ->orderByStartDtAsc(Orm::year())->orderBySeqAsc()->getsBySeq([42, 43]);
    return [
        'counts' => $counts,
        'months' => array_map(static fn(Author $r): int => derivedInteger($r->getStartMonth()), $rows->all())
    ];
});

vector('errors', fn() => [
    caught(fn() => $author()->name('a')->isClose(true)->gets()),
    caught(fn() => $author()->name('a')->and()->gets()),
    caught(fn() => $author()->seq([])->gets()),
    caught(fn() => (new Author())->name('a')->gets()),
    caught(fn() => $author()->forUpdate()->gets()),
    caught(fn() => $author()->joinUserSeqWithSeq((new User())($db))->gets()),
    caught(fn() => $author()->limit(0, 1)->getsPage(1, 10)),
    caught(fn() => $author()->relation((new User())->matchUserSeqWithSeq()->limit(0, 1))->getsBySeq(42)),
    caught(fn() => $author()->name('a')->or(new User())->gets()),
]);

vector('get_query', function () use ($author): array {
    $st = $author()->serviceSeq(7)
        ->andLkName('x')
        ->andAesHexEmail('user7@example.com')
        ->orderBySeqDesc()
        ->limit(0, 5)
        ->getQuery();
    return ['sql' => $st['sql'], 'binds' => array_map('norm', $st['binds'])];
});

vector('aes_values', function () use ($author): array {
    $row = $author()->removeAllColumns()->addColumnAesHexEmail()->addColumnAesHexPhone()->getBySeq(42);
    return ['row' => $row->toArray(), 'found' => $author()->aesHexEmail('user42@example.com')->getCount()];
});

vector('write_cycle', function () use ($author): array {
    $start = '2026-06-01 00:00:00.000000';
    $created = $author()
        ->setName('cycle')->setUserSeq(1)->setServiceSeq(999)->setServiceRegionSeq(1)->setServiceMemberSeq(1)
        ->setStartDt($start)
            ->setEndDt($start)
            ->setPrice('12.500')
            ->setIp('10.0.0.1')
            ->setAesHexEmail('cycle@example.com')
        ->setJsonSetting(StyledValue::value(['a' => 1]))->setSerializeData(StyledValue::value(['k' => 'v']))
        ->newLabel('created')
        ->create();
    $seq = $created->getSeq();
    mask([$seq]);
    $createdArray = $created->toArray();
    $createdArray['seq'] = '$SEQ';
    $loaded = $author()->addAllColumns()->getBySeq($seq);
    mask([], [$loaded->getUpdatedTs()]);
    $loaded->setName('cycle-2')->plusReadCount(3)->update(true);
    $stale = caught(fn() => $loaded->setName('stale')->update(true));
    $again = $author()->addAllColumns()->getBySeq($seq);
    $updated = pick(
        $again,
        'name',
        'read_count',
        'price',
        'ip',
        'aes_hex_email',
        'json_setting',
        'serialize_data',
        'start_dt'
    );
    $again->delete();
    $gone = caught(fn() => $author()->getBySeq($seq));
    return ['created' => $createdArray, 'updated' => $updated, 'stale' => $stale, 'deleted' => $gone];
});

vector('now_defaults', function () use ($author): array {
    $start = '2026-06-01 00:00:00.000000';
    $before = microtime(true);
    $created = $author()
        ->setName('clock')->setUserSeq(1)->setServiceSeq(999)->setServiceRegionSeq(1)->setServiceMemberSeq(1)
        ->setStartDt($start)->setEndDt($start)
        ->create();
    $seq = $created->getSeq();
    mask([$seq]);
    $loaded = $author()->getBySeq($seq);
    $createdTs = $loaded->getCreatedTs();
    $updatedTs = $loaded->getUpdatedTs();
    $near = abs((float) $createdTs->format('U.u') - $before) < 60;
    $loaded->delete();
    return ['created_near_clock' => $near, 'created_equals_updated' => $createdTs == $updatedTs];
});

vector('required_columns', function () use ($db): array {
    $failure = static function (callable $fn): ?array {
        try {
            $fn();
        } catch (Throwable $e) {
            return ['error' => code($e), 'message' => $e->getMessage()];
        }
        return null;
    };
    $missingState = $failure(fn() => (new Task())($db)->setTitle('draft')->create());
    $missingTitle = $failure(fn() => (new Task())($db)->setState('open')->create());
    $created = (new Task())($db)->setTitle('draft')->setState('open')->create();
    mask([$created->getSeq()]);
    $created->delete();
    return ['missing_state' => $missingState, 'missing_title' => $missingTitle];
});

vector('creates_and_save', function () use ($db): array {
    $inserted = (new CompositeAccount())($db)->creates([
        (new CompositeAccount())->setTenantId(900)->setAccountId(1)->setName('a'),
        (new CompositeAccount())->setTenantId(900)->setAccountId(2)->setName('b'),
        (new CompositeAccount())->setTenantId(901)->setAccountId(1)->setName('c'),
    ], 2);
    (new CompositeAccount())($db)->setTenantId(900)->setAccountId(1)->setName('dup')
        ->duplication((new CompositeAccount())->setName('updated'))->create();
    (new CompositeAccount())($db)->setTenantId(900)->setAccountId(2)->setName('saved')->save();
    $pairs = (new CompositeAccount())($db)->tupleTenantIdWithAccountId([[900, 1], [900, 2]])
        ->orderByAccountIdAsc()
        ->gets();
    (new CompositeAccount())($db)->tenantId([900, 901])->orderByTenantIdAsc()->orderByAccountIdAsc()->gets()->delete();
    $left = (new CompositeAccount())($db)->tenantId([900, 901])->getCount();
    return ['inserted' => $inserted, 'pairs' => $pairs->toArray(), 'left' => $left];
});

// creates(rows, batch) runs each batch of batch rows as one multi-row INSERT in one transaction; a batch that
// is not a positive integer is CONFIG before any statement (docs/spec/protocol.md).
vector('creates_batch', function () use ($db): array {
    $rows = [];
    foreach (['a', 'b', 'c', 'd', 'e'] as $i => $name) {
        $rows[] = (new CompositeAccount())->setTenantId(903)->setAccountId($i + 1)->setName($name);
    }
    $inserted = (new CompositeAccount())($db)->creates($rows, 2);
    $zero = caught(fn() => (new CompositeAccount())($db)->creates($rows, 0));
    $count = (new CompositeAccount())($db)->tenantId([903])->getCount();
    (new CompositeAccount())($db)->tenantId([903])->orderByAccountIdAsc()->gets()->delete();
    return ['inserted' => $inserted, 'zero' => $zero, 'count' => $count];
});

// A batch whose binds exceed the bind limit is BATCH_TOO_LARGE before any statement: 21846 rows of three columns
// bind 65538 parameters, over the limit of every dialect.
vector('creates_batch_too_large', function () use ($db): array {
    $rows = [];
    for ($i = 1; $i <= 21846; $i++) {
        $rows[] = (new CompositeAccount())->setTenantId(904)->setAccountId($i)->setName('n');
    }
    $code = caught(fn() => (new CompositeAccount())($db)->creates($rows, count($rows)));
    return ['code' => $code, 'count' => (new CompositeAccount())($db)->tenantId([904])->getCount()];
});

/**
 * Creates the Apple, apple, Évian, évian, x_y rows in tenant 902, collects the account_id each pattern selects with
 * $cond, then deletes them.
 */
function containsVector(Db $db, callable $cond, string ...$patterns): array
{
    $rows = [];
    foreach (['Apple', 'apple', 'Évian', 'évian', 'x_y'] as $i => $name) {
        $rows[] = (new CompositeAccount())->setTenantId(902)->setAccountId($i + 1)->setName($name);
    }
    (new CompositeAccount())($db)->creates($rows, count($rows));
    $matches = [];
    foreach ($patterns as $p) {
        $matches[] = picks(
            $cond((new CompositeAccount())($db)->tenantId(902), $p)->orderByAccountIdAsc()->gets(),
            'account_id'
        );
    }
    (new CompositeAccount())($db)->tenantId(902)->orderByAccountIdAsc()->gets()->delete();
    return $matches;
}

vector(
    'contains_ascii_fold',
    fn() => containsVector($db, fn(CompositeAccount $q, string $p) => $q->andLkName($p), 'PPL', 'ÉV', '_', '')
);
vector(
    'contains_binary_code_point',
    fn() => containsVector($db, fn(CompositeAccount $q, string $p) => $q->andLbName($p), 'pp', 'É', 'PPL', '_')
);

vector('delete_recursive', function () use ($db): array {
    $service = (new Service())($db)->setName('recursive')->create();
    $seq = $service->getSeq();
    $seqs = [$seq];
    foreach ([1, 2] as $user) {
        $seqs[] = (new ServiceMember())($db)->setServiceSeq($seq)->setUserSeq($user)->create()->getSeq();
    }
    $loaded = (new Service())($db)->relations((new ServiceMember())->matchSeqWithServiceSeq())->getBySeq($seq);
    $members = count($loaded->getServiceMemberModels());
    mask($seqs);
    $loaded->delete(true);
    $left = (new ServiceMember())($db)->getCountByServiceSeq($seq);
    return [
        'members' => $members,
        'members_left' => $left,
        'service_left' => caught(fn() => (new Service())($db)->getBySeq($seq))
    ];
});

vector('transactions', function () use ($db): array {
    $boom = new RuntimeException('boom');
    $events = [];
    try {
        $db->transaction(function () use ($db, $boom, &$events): void {
            (new Service())->setName('tx-outer')->create();
            try {
                $db->transaction(function () use ($boom): void {
                    (new Service())->setName('tx-inner')->create();
                    throw $boom;
                });
                $events[] = false;
            } catch (RuntimeException $e) {
                $events[] = $e === $boom;
            }
            $events[] = (new Service())->name(['tx-outer', 'tx-inner'])->getCount();
            $events[] = count((new Service())->name('tx-outer')->forUpdate()->gets());
            $db->utils()->lock('conformance');
            $db->utils()->setLocal('ormtest.actor', 'runner');
            $events[] = $db->utils()->local('ormtest.actor');
            throw $boom;
        }, retry: 0);
        $events[] = false;
    } catch (RuntimeException $e) {
        $events[] = $e === $boom;
    }
    $events[] = (new Service())($db)->name(['tx-outer', 'tx-inner'])->getCount();
    return $events;
});

vector('restore', function () use ($db): array {
    // Restores a soft-deleted row by its primary key. The deletion time is written as a pinned value so every database
    // and runner binds the same. The transaction ends with a rollback, so the database is unchanged from the start.
    $boom = new RuntimeException('boom');
    $result = [];
    try {
        $db->transaction(function () use ($boom, &$result): void {
            $created = (new SoftRecord())->setName('restore')->create();
            $seq = $created->getSeq();
            mask([$seq]);
            $created->setDeletedAt('2026-01-02 03:04:05.000000')->update();
            $result['hidden'] = caught(fn() => (new SoftRecord())->getBySeq($seq));
            // Values outside the key are used only when restoring a deleted row. A second restore does not change a row
            // that was not deleted, and returns it unchanged.
            foreach (['restored' => 'restore-2', 'again' => 'ignored'] as $name => $value) {
                $array = (new SoftRecord())->setSeq($seq)->setName($value)->restore()->toArray();
                $array['seq'] = '$SEQ';
                $result[$name] = $array;
            }
            $result['missing'] = caught(fn() => (new SoftRecord())->setSeq(0)->restore());
            throw $boom;
        }, retry: 0);
        throw new RuntimeException('the restore transaction committed');
    } catch (RuntimeException $e) {
        if ($e !== $boom) {
            throw $e;
        }
    }
    $result['left'] = (new SoftRecord())($db)->name('restore')->getCount();
    return $result;
});
vector('restore_or_create', function () use ($db): array {
    // restoreOrCreate restores the soft-deleted row of its key, refuses a live row with ROW_NOT_DELETED and creates a
    // missing key (docs/operations/usage.md "Restore or create a row"). The transaction ends with a rollback, so the
    // database is unchanged.
    $boom = new RuntimeException('boom');
    $result = [];
    try {
        $db->transaction(function () use ($boom, &$result): void {
            $created = (new SoftLink())->setCode('roc-1')->setLabel('first')->create();
            mask([$created->getSeq()]);
            $created->setDeletedAt('2026-01-02 03:04:05.000000')->update();
            $restored = (new SoftLink())->setCode('roc-1')->setLabel('second')->restoreOrCreate()->toArray();
            $restored['seq'] = '$SEQ';
            $result['restored'] = $restored;
            $result['live'] = caught(fn() => (new SoftLink())->setCode('roc-1')->setLabel('third')->restoreOrCreate());
            $made = (new SoftLink())->setCode('roc-2')->setLabel('new')->restoreOrCreate();
            mask([$made->getSeq()]);
            $createdRow = $made->toArray();
            $createdRow['seq'] = '$SEQ';
            $result['created'] = $createdRow;
            throw $boom;
        }, retry: 0);
        throw new RuntimeException('the restore_or_create transaction committed');
    } catch (RuntimeException $e) {
        if ($e !== $boom) {
            throw $e;
        }
    }
    $result['left'] = (new SoftLink())($db)->getCount();
    return $result;
});

vector('expect_revision', function () use ($db): array {
    // expectRevision makes an update or a delete write only while author 42's like_count still holds the expected
    // revision; an update stores revision + 1, and a mismatch is REVISION_CHANGED and writes nothing (docs/spec/dsl.md
    // "Writes"). The transaction ends with a rollback, so the database is unchanged.
    $boom = new RuntimeException('boom');
    $result = [];
    $read = function (): array {
        $row = (new Author())->getBySeq(42);
        return ['name' => $row->getName(), 'like_count' => $row->getLikeCount()];
    };
    try {
        $db->transaction(function () use ($boom, $read, &$result): void {
            $result['before'] = $read();
            $revision = $result['before']['like_count'];
            (new Author())->setSeq(42)->setName('revision-1')->expectRevision('like_count', $revision)->update();
            $result['updated'] = $read();
            $result['update_mismatch'] = caught(
                fn() => (new Author())->setSeq(42)
                    ->setName('revision-stale')
                    ->expectRevision('like_count', $revision)
                    ->update()
            );
            $result['after_mismatch'] = $read();
            $result['delete_mismatch'] = caught(
                fn() => (new Author())->setSeq(42)->expectRevision('like_count', $revision)->delete()
            );
            $result['kept'] = (new Author())->seq(42)->getCount();
            $result['delete_match'] = caught(
                fn() => (new Author())->setSeq(42)->expectRevision('like_count', $revision + 1)->delete()
            );
            $result['deleted'] = (new Author())->seq(42)->getCount();
            throw $boom;
        }, retry: 0);
        throw new RuntimeException('the expect_revision transaction committed');
    } catch (RuntimeException $e) {
        if ($e !== $boom) {
            throw $e;
        }
    }
    $result['left'] = (new Author())($db)->seq(42)->getCount();
    return $result;
});

vector('joins_soft_deleted', function () use ($db): array {
    // A joined soft_record row that is soft deleted meets no parent: the inner join drops the parent and the left join
    // gives it a null child. The transaction rolls back at the end, so the database is as it was.
    $boom = new RuntimeException('boom');
    $names = ['soft-join-live', 'soft-join-deleted'];
    $result = [];
    try {
        $db->transaction(function () use ($boom, $names, &$result): void {
            foreach ($names as $name) {
                $service = (new Service())->setName($name)->create();
                $record = (new SoftRecord())->setName($name)->create();
                mask([$service->getSeq(), $record->getSeq()]);
                if ($name === 'soft-join-deleted') {
                    $record->setDeletedAt('2026-01-02 03:04:05.000000')->update();
                }
            }
            $inner = (new Service())->joinNameWithName((new SoftRecord())->aliasRecord())
                ->name($names)
                ->orderByNameAsc()
                ->gets();
            $result['inner'] = picks($inner, 'name');
            $left = (new Service())->leftJoinNameWithName((new SoftRecord())->aliasRecord())
                ->name($names)
                ->orderByNameAsc()
                ->gets();
            $result['left'] = [];
            foreach ($left->all() as $row) {
                $result['left'][] = ['name' => $row->getName(), 'record' => pick($row->getRecord(), 'name')];
            }
            throw $boom;
        }, retry: 0);
        throw new RuntimeException('the joins_soft_deleted transaction committed');
    } catch (RuntimeException $e) {
        if ($e !== $boom) {
            throw $e;
        }
    }
    return $result;
});

vector('column_pairs', function () use ($author): array {
    // Two compared columns meet as dbspec check operands do (docs/spec/dbspec.md "Checks"): a comparison of two
    // columns, a column in a subquery column, a join and a relation run when their columns meet, here i32 with i64 and
    // text with varchar, and fail with OPERATOR_NOT_ALLOWED before any statement when they do not.
    $result = [];
    $s1 = new Service();
    $result['col_i32_i64'] = $author()->joinServiceSeqWithSeq($s1)->readCountLtSeq($s1)->getCount();
    $s2 = new Service();
    $result['col_text_varchar'] = $author()->joinServiceSeqWithSeq($s2)->descriptionNeName($s2)->getCount();
    $result['in_i32_i64'] = $author()->likeCount((new User())->addColumnSeq())->getCount();
    $result['join_i32_i64'] = $author()->joinReadCountWithSeq(new Service())->getCount();
    $result['relation_i32_i64'] = count(
        $author()->relation((new Service())->matchLikeCountWithSeq())->orderBySeqAsc()->limit(0, 2)->gets()->all()
    );
    $s3 = new Service();
    $result['col_varchar_i64'] = caught(fn() => $author()->joinServiceSeqWithSeq($s3)->nameEqSeq($s3)->getCount());
    $s4 = new Service();
    $result['col_decimal_i64'] = caught(fn() => $author()->joinServiceSeqWithSeq($s4)->priceEqSeq($s4)->getCount());
    $result['in_varchar_i64'] = caught(fn() => $author()->name((new User())->addColumnSeq())->getCount());
    $result['join_varchar_i64'] = caught(fn() => $author()->joinNameWithSeq(new Service())->getCount());
    $result['relation_varchar_i64'] = caught(
        fn() => $author()->relation((new Service())->matchNameWithSeq())->limit(0, 1)->gets()
    );
    return $result;
});

vector('relative_time_out_of_range', function () use ($author): array {
    // A relative time function outside 0001-01-01 to 9999-12-31, or with an interval no database represents, is NULL,
    // so a comparison and its negation both match no row. secondsAgo takes an integer in every client, so 1e15 seconds
    // stands for an interval past every bound.
    $counts = [];
    foreach (
        [
        'seconds_ago' => Orm::secondsAgo(1000000000000000),
        'days_later' => Orm::daysLater(4000000),
        'months_ago' => Orm::monthsAgo(200000)
        ] as $name => $f
    ) {
        $counts[$name] = [$author()->andGtStartDt($f)->getCount(), $author()->andLeStartDt($f)->getCount()];
    }
    return $counts;
});

vector('aes_status', function () use ($db): array {
    $status = $db->utils()->aes()->status(new Author(), new AesKeyring([1 => 'bench-salt'], 1));
    $versions = [];
    foreach ($status->versions as $v => $n) {
        $versions[] = "$v:$n";
    }
    sort($versions);
    return ['current' => $status->current, 'pending' => $status->pending, 'versions' => implode(',', $versions)];
});

// the seed stores raw hex cells that no encoder writes (benchmarks/sql/seed.*.sql)
vector('hex_malformed', fn(): array => [
    'white_space' => caught(fn() => (new HexCell())($db)->getBySeq(1)),
    'odd_length' => caught(fn() => (new HexCell())($db)->getBySeq(2)),
]);

// A datetime(p) or time(p) value is bound with exactly p fraction digits, the form the SQLite CHECK of the column
// requires (docs/spec/dialects.md); zeros past p are dropped. Each vector inserts, reads the row back by the same
// parameter and deletes it.
$at = '2026-06-01 12:34:56';
vector('datetime_p0_roundtrip', function () use ($db, $at): array {
    $created = (new TimeCell())($db)->setAt($at)->setClock('10:11:12')->create();
    mask([$created->getSeq()]);
    $rows = (new TimeCell())($db)->at($at)->gets();
    $created->delete();
    return picks($rows, 'clock');
});
vector('time_p3_roundtrip', function () use ($db, $at): array {
    $created = (new TimeCell())($db)->setAt($at)->setClock('10:11:12.345000')->create();
    mask([$created->getSeq()]);
    $rows = (new TimeCell())($db)->clock('10:11:12.345')->gets();
    $created->delete();
    return picks($rows, 'clock');
});

// A date and a time(0) column read back as their text form (the driver's date and time values are the codec's input).
vector('date_roundtrip', function () use ($db): array {
    $created = (new DayCell())($db)->setLabel('date')->setDay('2026-06-01')->setAtTime('10:11:12')->create();
    mask([$created->getSeq()]);
    $rows = (new DayCell())($db)->label('date')->gets();
    $created->delete();
    return dateOnly(picks($rows, 'day', 'at_time'));
});

vector('date_null', function () use ($db): array {
    $created = (new DayCell())($db)->setLabel('nil')->create();
    mask([$created->getSeq()]);
    $rows = (new DayCell())($db)->label('nil')->gets();
    $created->delete();
    return dateOnly(picks($rows, 'day', 'at_time'));
});

// An upsert has exactly one conflict key (docs/spec/protocol.md 1): upsert_cell leaves its identity primary key out, so
// the unique key on code is the one key that can meet the row; an insert that does not assign code is IR_INVALID before
// any statement.
vector('upsert_one_key', function () use ($db): array {
    $created = (new UpsertCell())($db)->setCode('k1')->setLabel('first')
        ->duplication((new UpsertCell())->setLabel('second'))->create();
    mask([$created->getSeq()]);
    $inserted = (new UpsertCell())($db)->code('k1')->gets();
    (new UpsertCell())($db)->setCode('k1')
        ->setLabel('other')
        ->duplication((new UpsertCell())->setLabel('second'))
        ->create();
    $updated = (new UpsertCell())($db)->code('k1')->gets();
    $unassigned = null;
    try {
        (new UpsertCell())($db)->setLabel('none')->duplication((new UpsertCell())->setLabel('second'))->create();
    } catch (Throwable $e) {
        $unassigned = ['error' => code($e), 'message' => $e->getMessage()];
    }
    $updated->delete();
    return [
        'inserted' => picks($inserted, 'label'),
        'updated' => picks($updated, 'label'),
        'unassigned' => $unassigned
    ];
});

// A write counts each written row once (docs/spec/protocol.md "Write"): an upsert is 1 whether it inserts or updates,
// and an update counts the row it matched even when the row already holds the value. The count is read through the test
// entry point (docs/spec/protocol.md "Test write result").
// A PostgreSQL uuid column is read as its text and a uuid value is bound as text cast to uuid, in one form in every
// planner (docs/spec/dialects.md); the vector inserts, reads the row back by the same value and deletes it.
vector('uuid_roundtrip', function () use ($db): array {
    $created = (new UuidCell())($db)->setId('0f8e2d4c-1a3b-4c5d-8e9f-a0b1c2d3e4f5')->create();
    mask([$created->getSeq()]);
    $rows = (new UuidCell())($db)->id('0f8e2d4c-1a3b-4c5d-8e9f-a0b1c2d3e4f5')->gets();
    $created->delete();
    return picks($rows, 'id');
});

vector('affected_counts', function () use ($db): array {
    $out = [];
    $created = (new UpsertCell())($db)->setCode('c1')
        ->setLabel('x')
        ->duplication((new UpsertCell())->setLabel('y'))
        ->create();
    mask([$created->getSeq()]);
    $out['upsert_inserted'] = Faults::lastAffected($db);
    (new UpsertCell())($db)->setCode('c1')->setLabel('x')->duplication((new UpsertCell())->setLabel('y'))->create();
    $out['upsert_updated'] = Faults::lastAffected($db);
    $row = (new UpsertCell())($db)->getBySeq($created->getSeq());
    $row->setLabel('y')->update();
    $out['update_unchanged'] = Faults::lastAffected($db);
    $row->setLabel('z')->update();
    $out['update_changed'] = Faults::lastAffected($db);
    $row->delete();
    return $out;
});

// A value outside the logical type of its slot is CODEC_ENCODE before any statement (docs/spec/protocol.md §5
// "Parameters"). A create that the client lets through is deleted, so the vector leaves the database as it found it.
$rejected = static function (callable $create): array {
    try {
        $created = $create();
    } catch (Throwable $e) {
        return ['code' => code($e)];
    }
    mask([$created->getSeq()]);
    $created->delete();
    return ['code' => null];
};
vector(
    'datetime_precision_rejected',
    fn(): array => $rejected(
        fn() => (new TimeCell())($db)->setAt('2026-06-01 12:34:56.5')->setClock('10:11:12')->create()
    )
);
vector(
    'varchar_length_rejected',
    fn(): array => $rejected(fn() => (new BindCell())($db)->setLabel('123456789')->create())
);
vector(
    'text_nul_rejected',
    fn(): array => $rejected(fn() => (new BindCell())($db)->setLabel('nul')->setBody("a\0b")->create())
);
vector(
    'uuid_form_rejected',
    fn(): array => $rejected(
        fn() => (new BindCell())($db)->setLabel('uuid')->setToken('123E4567-E89B-12D3-A456-426614174000')->create()
    )
);
// A parameter that assigns NULL to a non-null column is CODEC_ENCODE before any statement (docs/spec/protocol.md §5
// "Parameters"); creates binds each row value as a parameter.
vector('null_into_not_null', function () use ($db): array {
    // The typed setter takes a string, so the row writes NULL through the column writer of the model.
    $null = new BindCell();
    (new ReflectionMethod(BindCell::class, 'writeColumn'))->invoke($null, 'label', null);
    return ['code' => caught(fn() => (new BindCell())($db)->creates([(new BindCell())->setLabel('a'), $null], 2))];
});
// A contains value NULL binds NULL, so `col LIKE NULL` matches no row (docs/spec/protocol.md §2).
vector('contains_null', function () use ($author): array {
    try {
        return ['code' => null, 'count' => $author()->serviceSeq(7)->andLkName(null)->getCount()];
    } catch (Throwable $e) {
        return ['code' => code($e), 'count' => null];
    }
});

// One statement has one clock (docs/spec/protocol.md "Clock"): the columns that an insert leaves to `default now` hold
// that clock truncated to their digits, and a datetime(p) column compares with a clock at six digits. The executor
// clock is fixed at .999999 through the test entry point, so a rounding clock shows as the next second; MySQL writes
// its own clock, CURRENT_TIMESTAMP(p), which truncates. These vectors come last because the fixed clock stays on the
// connection.
vector('clock_truncate_write', function () use ($db): array {
    Faults::fixClock($db, '2026-06-01 12:34:56.999999');
    $created = (new ClockCell())($db)->setLabel('write')->create();
    mask([$created->getSeq()]);
    $row = (new ClockCell())($db)->getBySeq($created->getSeq());
    $row->delete();
    $at6 = $row->getAt6();
    return [
        'p0_truncated' => $row->getAt0()->format('Y-m-d H:i:s.u') === $at6->format('Y-m-d H:i:s') . '.000000',
        'p3_truncated' => $row->getAt3()->format('Y-m-d H:i:s.u') === $at6->format('Y-m-d H:i:s.v') . '000',
    ];
});
vector('clock_compare_six_digits', function () use ($db): array {
    Faults::fixClock($db, '2026-06-01 12:34:56.999999');
    $utc = new DateTimeZone('UTC');
    $created = (new ClockCell())($db)->setLabel('compare')
        ->setAt0('2026-06-01 12:34:56')
        ->setAt3('2026-06-01 12:34:56.999')
        ->setAt6('2026-06-01 12:34:56')->create();
    mask([$created->getSeq()]);
    $geNow = (new ClockCell())($db)->label('compare')->andGeAt0(Orm::now())->getCount();
    $ltNow = (new ClockCell())($db)->label('compare')->andLtAt3(Orm::now())->getCount();
    $created->delete();
    return ['at0_ge_now' => $geNow, 'at3_lt_now' => $ltNow];
});
// the seed prices the authors of service 100 except a seq that is a multiple of 3 (benchmarks/sql/seed.*.sql)
vector('order_nulls', function () use ($author, $db): array {
    $priced = static fn(): Author => $author()->removeAllColumns()->addColumnPrice()->serviceSeq(100)->andLtSeq(500);
    $asc = $priced()->orderByPriceAsc()->orderBySeqAsc()->gets()->toArray();
    $desc = $priced()->orderByPriceDesc()->orderBySeqAsc()->gets()->toArray();
    $perParent = [];
    foreach (['asc', 'desc'] as $order) {
        $child = (new Author())->matchSeqWithUserSeq()->removeAllColumns()->addColumnPrice();
        $order === 'asc' ? $child->orderByPriceAsc() : $child->orderByPriceDesc();
        $perParent[$order] = (new User())($db)->relations($child->orderBySeqAsc()->groupLimit(2))
            ->seq(100)
            ->gets()
            ->toArray();
    }
    return [
        'asc' => $asc,
        'desc' => $desc,
        'limit_per_parent' => $perParent,
    ];
});

// user 100 has the authors 99 (price NULL) and 5099 (price 3.000) under seq 10000 (benchmarks/sql/seed.*.sql)
vector('scalar_column_subquery', function () use ($db): array {
    $out = [];
    foreach (['asc', 'desc'] as $order) {
        $users = (new User())($db)->addColumnReadTotal(static function (User $u) use ($order): Author {
            $sub = (new Author())->removeAllColumns()->addColumnName()->userSeqEqSeq($u)->andLtSeq(10000);
            $order === 'asc' ? $sub->orderByPriceAsc() : $sub->orderByPriceDesc();
            return $sub->orderBySeqAsc()->limit(0, 1);
        })->seq(100)->gets()->all();
        $out[$order] = array_map(static fn(User $u): array => [$u->getSeq(), $u->getReadTotal()], $users);
    }
    return $out;
});

// a flattened region of a closed author (seq, name and service_seq collide with the parent; absent for an open author)
// that holds a flattened service (seq and name collide) with its service members
vector('relations_flatten', fn() => $author()
    ->removeAllColumns()->addColumnName()->addColumnIsClose()
    ->relation((new ServiceRegion())->matchServiceRegionSeqWithSeq()->possibleIsClose(true)->parentNode()
        ->relation((new Service())->matchServiceSeqWithSeq()->parentNode()
            ->relations(
                (new ServiceMember())->matchSeqWithServiceSeq()->removeAllColumns()->orderBySeqAsc()->groupLimit(2)
            )))
    ->serviceSeq(7)->orderBySeqAsc()->limit(0, 8)->gets()->toArray());

foreach (array_keys($selected) as $name) {
    if (!isset($vectors[$name])) {
        throw new RuntimeException("unknown vector $name");
    }
}
foreach ($vectors as $name => $fn) {
    if ($selected === [] || isset($selected[$name])) {
        run($name, $fn);
    }
}

echo Model::jsonText($out), "\n";
