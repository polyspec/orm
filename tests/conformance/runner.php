<?php
// Conformance runner (PHP). Runs the chains of runner_go/main.go and prints the same document.
// Usage: php tests/conformance/runner.php <schema.json> [--driver mysql|postgres|sqlite] [--dsn URI]
declare(strict_types=1);

require dirname(__DIR__, 2) . '/clients/php/tests/autoload.php';

use App\Orm\Battle;
use App\Orm\CompositeAccount;
use App\Orm\Service;
use App\Orm\ServiceMember;
use App\Orm\ServiceModule;
use App\Orm\User;
use Orm\AesKeyring;
use Orm\Collection;
use Orm\Config;
use Orm\Model;
use Orm\Orm;
use Orm\OrmException;

$schema = $argv[1] ?? throw new RuntimeException('schema.json required');
$driver = 'mysql';
$dsn = null;
for ($i = 2; $i < $argc; $i++) {
    match ($argv[$i]) {
        '--driver' => $driver = $argv[++$i],
        '--dsn' => $dsn = $argv[++$i],
        default => throw new RuntimeException("unknown argument {$argv[$i]}"),
    };
}
$dsn ??= match ($driver) {
    'postgres' => 'postgres:///orm_bench?host=/tmp&timezone=%2B00:00',
    'sqlite' => 'sqlite:///tmp/orm_bench.sqlite?_pragma=busy_timeout(5000)&timezone=%2B00:00',
    default => 'mysql://root@localhost/orm_bench?socket=/tmp/mysql.sock&timezone=%2B00:00',
};

$log = [];
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
        if (str_starts_with($v, 'ORM-AES2') || str_starts_with(strtolower($v), '4f524d2d41455332')) {
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
        $out[$n] = $all[$n] ?? null;
    }
    return $out;
}

function picks(Collection $c, string ...$names): array
{
    return array_map(static fn(Model $m): ?array => pick($m, ...$names), $c->all());
}

$db = Orm::connect($dsn, new Config(
    schemaPath: $schema,
    aesKey: 'bench-salt',
    blindIndexKey: 'bench-blind-index',
    onQuery: static function (string $sql, array $binds) use (&$log): void {
        $log[] = ['sql' => $sql, 'binds' => array_map('norm', $binds)];
    },
));

$out = [];
/** A result with every ordered-json value decoded; objects are stdClass, so {} stays apart from []. */
function plain(mixed $v): mixed
{
    if ($v instanceof OrderedJson\Value) {
        return json_decode(OrderedJson\stringify($v), false, 512, JSON_THROW_ON_ERROR);
    }
    return is_array($v) ? array_map('plain', $v) : $v;
}

function run(string $name, callable $fn): void
{
    global $out, $log, $maskSeqs, $maskTs;
    $log = [];
    $maskSeqs = [];
    $maskTs = [];
    try {
        $res = plain($fn());
    } catch (Throwable $e) {
        $res = ['error' => code($e)];
    }
    $out[$name] = ['statements' => $log, 'result' => $res];
}

$battle = static fn(): Battle => (new Battle)->connect($db);
$cols = ['seq', 'name', 'is_close', 'is_display', 'read_count'];

run('conditions_connectors', fn() => picks($battle()->serviceSeq(7)->andIsClose(false)->or()->readCount(6)->orderBySeqAsc()->limit(0, 3)->gets(), ...$cols));

run('conditions_group', fn() => picks($battle()->serviceSeq(7)
    ->and(fn(Battle $q) => $q->isDisplay(false)->or(fn(Battle $q) => $q->isClose(true)->andGtReadCount(500)))
    ->orderBySeqDesc()->limit(0, 3)->gets(), ...$cols));

run('conditions_leading_group', fn() => picks($battle()
    ->and(fn(Battle $q) => $q->isDisplay(false)->orIsClose(true))
    ->andServiceSeq(7)
    ->orderBySeqDesc()->limit(0, 3)->gets(), ...$cols));

run('conditions_leading_prefix', fn() => picks($battle()->andServiceSeq(7)->andGtReadCount(990)
    ->orderBySeqDesc()->limit(0, 3)->gets(), ...$cols));

run('conditions_values', fn() => array_map(static fn(Battle $q): int => $q->getCount(), [
    $battle()->serviceSeq([7, 8])->andNeIsClose(true),
    $battle()->serviceSeq(7)->andUuid(null),
    $battle()->serviceSeq(7)->andNeCoverUrl(null),
    $battle()->serviceSeq(7)->andNeReadCount([6, 106, 206]),
    $battle()->serviceSeq(7)->andBetweenReadCount([100, 200]),
    $battle()->serviceSeq(7)->andLkName('attle-10'),
    $battle()->serviceSeq(7)->andLbName('Battle-10'),
    $battle()->serviceSeq(7)->andGeReadCount(990),
    $battle()->serviceSeq(7)->andLeReadCount(10),
    $battle()->serviceSeq(7)->andLtSeq(1000),
]));

run('terminal_by', function () use ($battle, $cols): array {
    $one = $battle()->getBySeq(42);
    $missing = caught(fn() => $battle()->getBySeq(-1));
    $rows = $battle()->orderBySeqAsc()->limit(0, 2)->getsByServiceSeqAndIsClose(7, false);
    $count = $battle()->getCountByServiceSeq(7);
    return ['one' => pick($one, ...$cols), 'missing' => $missing, 'rows' => picks($rows, ...$cols), 'count' => $count];
});

run('terminal_reuse', function () use ($battle): array {
    $q = $battle()->serviceSeq(7)->orderBySeqAsc()->limit(0, 2);
    $first = $q->getCountByIsClose(true);
    $rows = $q->gets();
    return [$first, count($rows), $q->getCount()];
});

run('raw_forms', function () use ($battle): array {
    $count = $battle()->serviceSeq(7)->andRaw('{read_count} > ?', [990])->getCount();
    $rows = $battle()->raw('{seq} IN (?, ?)', [42, 43])
        ->removeAllColumns()->addRawColumnDoubled('({read_count} * ?)', [2])
        ->orderByRaw('{seq} DESC')->gets();
    return ['count' => $count, 'rows' => array_map(static fn(Battle $r): array => [$r->getSeq(), (int) $r->getDoubled()], $rows->all())];
});

run('columns', function () use ($db, $battle): array {
    $none = (new Service)($db)->removeAllColumns()->getBySeq(7);
    $added = $battle()->removeAllColumns()->addColumnName()->addColumnReadCountAliasReadText("CONCAT('r', %s)")->getBySeq(42);
    $removed = (new Service)($db)->removeColumnName()->getBySeq(7);
    return [$none->toArray(), pick($added, 'seq', 'name', 'read_text'), $removed->toArray()];
});

run('joins', function () use ($battle): array {
    $service = (new Service)->on(fn(Service $s) => $s->gtSeq(0))->name('service-7');
    $rows = $battle()
        ->removeAllColumns()->addColumnName()
        ->joinServiceSeqWithSeq($service)
        ->isClose(false)
        ->and(fn(Battle $q) => $q->isDisplay(true)->or($service))
        ->orderBySeqAsc()->limit(0, 2)->gets();
    $member = new ServiceMember;
    $compared = $battle()->joinServiceMemberSeqWithSeq($member)->serviceSeq(7)->andSuccessCountLtSeq($member)->getCount();
    $left = $battle()->leftJoinServiceModuleSeqWithSeq((new ServiceModule)->aliasModule())->serviceSeq(7)->orderBySeqAsc()->limit(0, 1)->gets();
    return ['rows' => $rows->toArray(), 'compared' => $compared, 'module' => pick($left->first()->getModule(), 'seq', 'name')];
});

run('relations', fn() => $battle()
    ->removeAllColumns()->addColumnName()->addColumnIsClose()
    ->relation((new User)->matchUserSeqWithSeq()->aliasWriter()
        ->relations((new Battle)->matchSeqWithUserSeq()->removeAllColumns()->orderBySeqDesc()->groupLimit(2)))
    ->relation((new Service)->matchServiceSeqWithSeq()
        ->relations((new ServiceMember)->matchSeqWithServiceSeq()->removeAllColumns()->orderBySeqAsc()->groupLimit(2)->keyNameUserSeq()))
    ->relation((new ServiceModule)->matchServiceModuleSeqWithSeq()->possibleIsClose(true)->parentNode())
    ->serviceSeq(7)->orderBySeqAsc()->limit(0, 3)->gets()->toArray());

run('relation_empty', fn() => count($battle()->relations((new ServiceMember)->matchUserSeqWithUserSeq())->getsBySeq(-1)));

run('subqueries', fn() => array_map(
    static fn(User $u): array => [$u->getSeq(), (int) $u->getReadTotal()],
    (new User)($db)
        ->addColumnReadTotal(fn(User $u) => (new Battle)->sumReadCount()->userSeqEqSeq($u)->andServiceSeq(7))
        ->seq((new Battle)->addColumnUserSeq()->serviceSeq(7)->andGeReadCount(906))
        ->orderBySeqAsc()->gets()->all(),
));

run('aggregates', function () use ($battle): array {
    $sum = $battle()->serviceSeq(7)->sumReadCount()->getSum();
    $avg = $battle()->serviceSeq(7)->avgLikeCount()->getAvg();
    $groups = $battle()->serviceSeq(7)->groupByIsClose()->orderByIsCloseAsc()->getsCount();
    $page = $battle()->serviceSeq(7)->removeAllColumns()->orderBySeqAsc()->getsPage(3, 4);
    return [
        'sum' => $sum,
        'avg' => sprintf('%.4f', $avg),
        'groups' => $groups->toArray(),
        'page' => ['keys' => $page->items->keys(), 'total' => $page->totalCount, 'pages' => $page->totalPages, 'page' => $page->page, 'per_page' => $page->perPage],
    ];
});

run('functions', function () use ($battle): array {
    $counts = array_map(static fn(Battle $q): int => $q->getCount(), [
        $battle()->serviceSeq(7)->andEqStartDt(Orm::dayOfWeek(), 2),
        $battle()->serviceSeq(7)->andStartDt(Orm::year(), 2026),
        $battle()->serviceSeq(7)->andGtStartDt(Orm::daysAgo(36500)),
        $battle()->serviceSeq(7)->andLtStartDt(Orm::monthsLater(1200)),
    ]);
    $rows = $battle()->removeAllColumns()->addColumnStartDtAliasStartMonth(Orm::month())
        ->orderByStartDtAsc(Orm::year())->orderBySeqAsc()->getsBySeq([42, 43]);
    return ['counts' => $counts, 'months' => array_map(static fn(Battle $r): int => (int) $r->getStartMonth(), $rows->all())];
});

run('errors', fn() => [
    caught(fn() => $battle()->name('a')->isClose(true)->gets()),
    caught(fn() => $battle()->name('a')->and()->gets()),
    caught(fn() => $battle()->seq([])->gets()),
    caught(fn() => (new Battle)->name('a')->gets()),
    caught(fn() => $battle()->forUpdate()->gets()),
    caught(fn() => $battle()->joinUserSeqWithSeq((new User)($db))->gets()),
    caught(fn() => $battle()->limit(0, 1)->getsPage(1, 10)),
    caught(fn() => $battle()->relation((new User)->matchUserSeqWithSeq()->limit(0, 1))->getsBySeq(42)),
    caught(fn() => $battle()->name('a')->or(new User)->gets()),
]);

run('get_query', function () use ($battle): array {
    $st = $battle()->serviceSeq(7)->andLkName('x')->andAesHexEmail('user7@example.com')->orderBySeqDesc()->limit(0, 5)->getQuery();
    return ['sql' => $st['sql'], 'binds' => array_map('norm', $st['binds'])];
});

run('aes_values', function () use ($battle): array {
    $row = $battle()->removeAllColumns()->addColumnAesHexEmail()->addColumnAesHexPhone()->getBySeq(42);
    return ['row' => $row->toArray(), 'found' => $battle()->aesHexEmail('user42@example.com')->getCount()];
});

run('write_cycle', function () use ($battle): array {
    $start = new DateTimeImmutable('2026-06-01 00:00:00', new DateTimeZone('UTC'));
    $created = $battle()
        ->setName('cycle')->setUserSeq(1)->setServiceSeq(999)->setServiceModuleSeq(1)->setServiceMemberSeq(1)
        ->setStartDt($start)->setEndDt($start)->setPrice(12.5)->setIp('10.0.0.1')->setAesHexEmail('cycle@example.com')
        ->setJsonSetting(['a' => 1])->setSerializeData(['k' => 'v'])
        ->newLabel('created')
        ->create();
    $seq = $created->getSeq();
    mask([$seq]);
    $createdArray = $created->toArray();
    $createdArray['seq'] = '$SEQ';
    $loaded = $battle()->addAllColumns()->getBySeq($seq);
    mask([], [$loaded->getUpdatedTs()]);
    $loaded->setName('cycle-2')->plusReadCount(3)->update(true);
    $stale = caught(fn() => $loaded->setName('stale')->update(true));
    $again = $battle()->addAllColumns()->getBySeq($seq);
    $updated = pick($again, 'name', 'read_count', 'price', 'ip', 'aes_hex_email', 'json_setting', 'serialize_data', 'start_dt');
    $again->delete();
    $gone = caught(fn() => $battle()->getBySeq($seq));
    return ['created' => $createdArray, 'updated' => $updated, 'stale' => $stale, 'deleted' => $gone];
});

run('now_defaults', function () use ($battle): array {
    $start = new DateTimeImmutable('2026-06-01 00:00:00', new DateTimeZone('UTC'));
    $before = microtime(true);
    $created = $battle()
        ->setName('clock')->setUserSeq(1)->setServiceSeq(999)->setServiceModuleSeq(1)->setServiceMemberSeq(1)
        ->setStartDt($start)->setEndDt($start)
        ->create();
    $seq = $created->getSeq();
    mask([$seq]);
    $loaded = $battle()->getBySeq($seq);
    $createdTs = $loaded->getCreatedTs();
    $updatedTs = $loaded->getUpdatedTs();
    $near = abs((float) $createdTs->format('U.u') - $before) < 60;
    $loaded->delete();
    return ['created_near_clock' => $near, 'created_equals_updated' => $createdTs == $updatedTs];
});

run('creates_and_save', function () use ($db): array {
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

run('delete_recursive', function () use ($db): array {
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

run('transactions', function () use ($db): array {
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
            $db->utils()->setLocal('app.actor', 'runner');
            $events[] = $db->utils()->local('app.actor');
            throw $boom;
        }, retry: 0);
        $events[] = false;
    } catch (RuntimeException $e) {
        $events[] = $e === $boom;
    }
    $events[] = (new Service)($db)->name(['tx-outer', 'tx-inner'])->getCount();
    return $events;
});

run('aes_status', function () use ($db): array {
    $status = $db->utils()->aes()->status(new Battle, new AesKeyring([1 => 'bench-salt'], 1));
    $versions = [];
    foreach ($status->versions as $v => $n) {
        $versions[] = "$v:$n";
    }
    sort($versions);
    return ['current' => $status->current, 'pending' => $status->pending, 'versions' => implode(',', $versions)];
});

echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR), "\n";
