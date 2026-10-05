<?php
// Conformance runner (PHP). Runs the chains of runner_go/main.go and prints the same document.
// Usage: php tests/conformance/runner.php --dsn URI [--vector NAME]...
// --vector는 반복할 수 있고, 주어지면 이름이 같은 vector만 실행한다. 모르는 이름은 오류다.
declare(strict_types=1);

require dirname(__DIR__, 2) . '/clients/php/tests/autoload.php';
require __DIR__ . '/result_php_helpers.php';

use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Tests\Model\CompositeAccount;
use Polyspec\Orm\Tests\Model\Service;
use Polyspec\Orm\Tests\Model\ServiceMember;
use Polyspec\Orm\Tests\Model\ServiceRegion;
use Polyspec\Orm\Tests\Model\SoftRecord;
use Polyspec\Orm\Tests\Model\Task;
use Polyspec\Orm\Tests\Model\User;
use Orm\AesKeyring;
use Orm\Collection;
use Orm\Config;
use Orm\Model;
use Orm\Orm;
use Orm\OrmException;
use Orm\StatementEvent;
use Orm\StyledValue;

$dsn = null;
$selected = [];
for ($i = 1; $i < $argc; $i++) {
    $flag = $argv[$i];
    if (($flag === '--dsn' || $flag === '--vector') && $i + 1 >= $argc) {
        throw new RuntimeException("$flag needs a value");
    }
    match ($flag) {
        '--dsn' => $dsn = $argv[++$i],
        '--vector' => isset($selected[$argv[++$i]]) ? throw new RuntimeException("duplicate --vector {$argv[$i]}") : $selected[$argv[$i]] = true,
        default => throw new RuntimeException("unknown argument $flag"),
    };
}
$dsn ?? throw new RuntimeException('--dsn required');

// $log는 vector의 statement event다(docs/usage.md "Statement events"). transaction은 vector 안에서
// 처음 나온 순서로 1부터 다시 센 번호이고 밖이면 null이다. error는 statement의 오류 code이거나 null이다.
$log = [];
/** @var array<int, int> vector 안의 transaction 번호를 처음 나온 순서의 번호로 바꾼다. */
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
            if (strlen($v) < 9 + 12 + 16) throw new RuntimeException('invalid AES ciphertext bind');
            return '$AES';
        }
        if (str_starts_with($v, 'ORM-AES2')) throw new RuntimeException('invalid AES ciphertext bind');
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

function picks(Collection $c, string ...$names): array
{
    return array_map(static fn(Model $m): ?array => pick($m, ...$names), $c->all());
}

$db = \Polyspec\Orm\Tests\Model\connect($dsn, new Config(
    aesKey: 'bench-salt',
    blindIndexKey: 'bench-blind-index',
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
/** @var array<string, callable> vector 이름별 chain, 선언 순서 */
$vectors = [];
$writeVectors = array_fill_keys(['write_cycle', 'now_defaults', 'required_columns', 'creates_and_save', 'delete_recursive'], true);

/** vector를 선언한다. 선택된 vector는 모든 선언이 끝난 뒤 선언 순서대로 실행한다. */
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
    $res = executeVector($name, $fn, isset($writeVectors[$name]) ? static fn(callable $task): mixed => $db->transaction($task, retry: 0) : null);
    $out[$name] = ['statements' => $log, 'result' => $res];
}

$author = static fn(): Author => (new Author)->connect($db);
$cols = ['seq', 'name', 'is_close', 'is_display', 'read_count'];

vector('conditions_connectors', fn() => picks($author()->serviceSeq(7)->andIsClose(false)->or()->readCount(6)->orderBySeqAsc()->limit(0, 3)->gets(), ...$cols));

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
    $author()->serviceSeq(7)->andLkName('attle-10'),
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

vector('raw_forms', function () use ($author): array {
    $count = $author()->serviceSeq(7)->andRaw('{read_count} > ?', [990])->getCount();
    $rows = $author()->raw('{seq} IN (?, ?)', [42, 43])
        ->removeAllColumns()->addRawColumnDoubled('({read_count} * ?)', [2])
        ->orderByRaw('{seq} DESC')->gets();
    return ['count' => $count, 'rows' => array_map(static fn(Author $r): array => [$r->getSeq(), derivedInteger($r->getDoubled())], $rows->all())];
});

vector('expression_forms', fn() => [
    'count' => $author()->serviceSeq(7)->andNot(fn(Author $q) => $q->isClose(true)->orGtReadCount(500))->getCount(),
    'rows' => picks($author()->not(fn(Author $q) => $q->isDisplay(false))->andServiceSeq(7)->orderBySeqDesc()->limit(0, 3)->gets(), 'seq', 'is_display'),
    'or_count' => $author()->serviceSeq(7)->orNot(fn(Author $q) => $q->ltReadCount(990))->getCount(),
]);

vector('columns', function () use ($db, $author): array {
    $none = (new Service)($db)->removeAllColumns()->getBySeq(7);
    $added = $author()->removeAllColumns()->addColumnName()->addColumnReadCountAliasReadText("CONCAT('r', %s)")->getBySeq(42);
    $removed = (new Service)($db)->removeColumnName()->getBySeq(7);
    return [$none->toArray(), pick($added, 'seq', 'name', 'read_text'), $removed->toArray()];
});

vector('joins', function () use ($author): array {
    $service = (new Service)->on(fn(Service $s) => $s->gtSeq(0))->name('service-7');
    $rows = $author()
        ->removeAllColumns()->addColumnName()
        ->joinServiceSeqWithSeq($service)
        ->isClose(false)
        ->and(fn(Author $q) => $q->isDisplay(true)->or($service))
        ->orderBySeqAsc()->limit(0, 2)->gets();
    $member = new ServiceMember;
    $compared = $author()->joinServiceMemberSeqWithSeq($member)->serviceSeq(7)->andSuccessCountLtSeq($member)->getCount();
    $left = $author()->leftJoinServiceRegionSeqWithSeq((new ServiceRegion)->aliasModule())->serviceSeq(7)->orderBySeqAsc()->limit(0, 1)->gets();
    return ['rows' => $rows->toArray(), 'compared' => $compared, 'module' => pick($left->first()->getModule(), 'seq', 'name')];
});

vector('relations', fn() => $author()
    ->removeAllColumns()->addColumnName()->addColumnIsClose()
    ->relation((new User)->matchUserSeqWithSeq()->aliasWriter()
        ->relations((new Author)->matchSeqWithUserSeq()->removeAllColumns()->orderBySeqDesc()->groupLimit(2)))
    ->relation((new Service)->matchServiceSeqWithSeq()
        ->relations((new ServiceMember)->matchSeqWithServiceSeq()->removeAllColumns()->orderBySeqAsc()->groupLimit(2)->keyNameUserSeq()))
    ->relation((new ServiceRegion)->matchServiceRegionSeqWithSeq()->possibleIsClose(true)->parentNode())
    ->serviceSeq(7)->orderBySeqAsc()->limit(0, 3)->gets()->toArray());

vector('relation_empty', fn() => count($author()->relations((new ServiceMember)->matchUserSeqWithUserSeq())->getsBySeq(-1)));

vector('subqueries', fn() => array_map(
    static fn(User $u): array => [$u->getSeq(), derivedInteger($u->getReadTotal())],
    (new User)($db)
        ->addColumnReadTotal(fn(User $u) => (new Author)->sumReadCount()->userSeqEqSeq($u)->andServiceSeq(7))
        ->seq((new Author)->addColumnUserSeq()->serviceSeq(7)->andGeReadCount(906))
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
        'page' => ['keys' => $page->items->keys(), 'total' => $page->totalCount, 'pages' => $page->totalPages, 'page' => $page->page, 'per_page' => $page->perPage],
    ];
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
    return ['counts' => $counts, 'months' => array_map(static fn(Author $r): int => derivedInteger($r->getStartMonth()), $rows->all())];
});

vector('errors', fn() => [
    caught(fn() => $author()->name('a')->isClose(true)->gets()),
    caught(fn() => $author()->name('a')->and()->gets()),
    caught(fn() => $author()->seq([])->gets()),
    caught(fn() => (new Author)->name('a')->gets()),
    caught(fn() => $author()->forUpdate()->gets()),
    caught(fn() => $author()->joinUserSeqWithSeq((new User)($db))->gets()),
    caught(fn() => $author()->limit(0, 1)->getsPage(1, 10)),
    caught(fn() => $author()->relation((new User)->matchUserSeqWithSeq()->limit(0, 1))->getsBySeq(42)),
    caught(fn() => $author()->name('a')->or(new User)->gets()),
]);

vector('get_query', function () use ($author): array {
    $st = $author()->serviceSeq(7)->andLkName('x')->andAesHexEmail('user7@example.com')->orderBySeqDesc()->limit(0, 5)->getQuery();
    return ['sql' => $st['sql'], 'binds' => array_map('norm', $st['binds'])];
});

vector('aes_values', function () use ($author): array {
    $row = $author()->removeAllColumns()->addColumnAesHexEmail()->addColumnAesHexPhone()->getBySeq(42);
    return ['row' => $row->toArray(), 'found' => $author()->aesHexEmail('user42@example.com')->getCount()];
});

vector('write_cycle', function () use ($author): array {
    $start = new DateTimeImmutable('2026-06-01 00:00:00', new DateTimeZone('UTC'));
    $created = $author()
        ->setName('cycle')->setUserSeq(1)->setServiceSeq(999)->setServiceRegionSeq(1)->setServiceMemberSeq(1)
        ->setStartDt($start)->setEndDt($start)->setPrice('12.500')->setIp('10.0.0.1')->setAesHexEmail('cycle@example.com')
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
    $updated = pick($again, 'name', 'read_count', 'price', 'ip', 'aes_hex_email', 'json_setting', 'serialize_data', 'start_dt');
    $again->delete();
    $gone = caught(fn() => $author()->getBySeq($seq));
    return ['created' => $createdArray, 'updated' => $updated, 'stale' => $stale, 'deleted' => $gone];
});

vector('now_defaults', function () use ($author): array {
    $start = new DateTimeImmutable('2026-06-01 00:00:00', new DateTimeZone('UTC'));
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
    $missingState = $failure(fn() => (new Task)($db)->setTitle('draft')->create());
    $missingTitle = $failure(fn() => (new Task)($db)->setState('open')->create());
    $created = (new Task)($db)->setTitle('draft')->setState('open')->create();
    mask([$created->getSeq()]);
    $created->delete();
    return ['missing_state' => $missingState, 'missing_title' => $missingTitle];
});

vector('creates_and_save', function () use ($db): array {
    $inserted = (new CompositeAccount)($db)->creates([
        (new CompositeAccount)->setTenantId(900)->setAccountId(1)->setName('a'),
        (new CompositeAccount)->setTenantId(900)->setAccountId(2)->setName('b'),
        (new CompositeAccount)->setTenantId(901)->setAccountId(1)->setName('c'),
    ]);
    (new CompositeAccount)($db)->setTenantId(900)->setAccountId(1)->setName('dup')
        ->duplication((new CompositeAccount)->setName('updated'))->create();
    (new CompositeAccount)($db)->setTenantId(900)->setAccountId(2)->setName('saved')->save();
    $pairs = (new CompositeAccount)($db)->tupleTenantIdWithAccountId([[900, 1], [900, 2]])->orderByAccountIdAsc()->gets();
    (new CompositeAccount)($db)->tenantId([900, 901])->orderByTenantIdAsc()->orderByAccountIdAsc()->gets()->delete();
    $left = (new CompositeAccount)($db)->tenantId([900, 901])->getCount();
    return ['inserted' => $inserted, 'pairs' => $pairs->toArray(), 'left' => $left];
});

vector('delete_recursive', function () use ($db): array {
    $service = (new Service)($db)->setName('recursive')->create();
    $seq = $service->getSeq();
    $seqs = [$seq];
    foreach ([1, 2] as $user) {
        $seqs[] = (new ServiceMember)($db)->setServiceSeq($seq)->setUserSeq($user)->create()->getSeq();
    }
    $loaded = (new Service)($db)->relations((new ServiceMember)->matchSeqWithServiceSeq())->getBySeq($seq);
    $members = count($loaded->getServiceMemberModels());
    mask($seqs);
    $loaded->delete(true);
    $left = (new ServiceMember)($db)->getCountByServiceSeq($seq);
    return ['members' => $members, 'members_left' => $left, 'service_left' => caught(fn() => (new Service)($db)->getBySeq($seq))];
});

vector('transactions', function () use ($db): array {
    $boom = new RuntimeException('boom');
    $events = [];
    try {
        $db->transaction(function () use ($db, $boom, &$events): void {
            (new Service)->setName('tx-outer')->create();
            try {
                $db->transaction(function () use ($boom): void {
                    (new Service)->setName('tx-inner')->create();
                    throw $boom;
                });
                $events[] = false;
            } catch (RuntimeException $e) {
                $events[] = $e === $boom;
            }
            $events[] = (new Service)->name(['tx-outer', 'tx-inner'])->getCount();
            $events[] = count((new Service)->name('tx-outer')->forUpdate()->gets());
            $db->utils()->lock('conformance');
            $db->utils()->setLocal('ormtest.actor', 'runner');
            $events[] = $db->utils()->local('ormtest.actor');
            throw $boom;
        }, retry: 0);
        $events[] = false;
    } catch (RuntimeException $e) {
        $events[] = $e === $boom;
    }
    $events[] = (new Service)($db)->name(['tx-outer', 'tx-inner'])->getCount();
    return $events;
});

vector('restore', function () use ($db): array {
    // soft delete한 행을 primary key로 되돌린다. 지운 시각은 고정한 값으로 써서 모든 database와 runner의
    // bind가 같다. transaction은 끝에 rollback하므로 database는 처음과 같다.
    $boom = new RuntimeException('boom');
    $result = [];
    try {
        $db->transaction(function () use ($boom, &$result): void {
            $created = (new SoftRecord)->setName('restore')->create();
            $seq = $created->getSeq();
            mask([$seq]);
            $created->setDeletedAt(new DateTimeImmutable('2026-01-02 03:04:05', new DateTimeZone('UTC')))->update();
            $result['hidden'] = caught(fn() => (new SoftRecord)->getBySeq($seq));
            // key 밖의 값은 지워진 행을 되돌릴 때만 쓴다. 두 번째 restore는 지워지지 않은 행을 바꾸지
            // 않고 돌려준다.
            foreach (['restored' => 'restore-2', 'again' => 'ignored'] as $name => $value) {
                $array = (new SoftRecord)->setSeq($seq)->setName($value)->restore()->toArray();
                $array['seq'] = '$SEQ';
                $result[$name] = $array;
            }
            $result['missing'] = caught(fn() => (new SoftRecord)->setSeq(0)->restore());
            throw $boom;
        }, retry: 0);
        throw new RuntimeException('the restore transaction committed');
    } catch (RuntimeException $e) {
        if ($e !== $boom) {
            throw $e;
        }
    }
    $result['left'] = (new SoftRecord)($db)->name('restore')->getCount();
    return $result;
});

vector('aes_status', function () use ($db): array {
    $status = $db->utils()->aes()->status(new Author, new AesKeyring([1 => 'bench-salt'], 1));
    $versions = [];
    foreach ($status->versions as $v => $n) {
        $versions[] = "$v:$n";
    }
    sort($versions);
    return ['current' => $status->current, 'pending' => $status->pending, 'versions' => implode(',', $versions)];
});

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
