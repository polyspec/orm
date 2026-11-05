<?php

// Conformance runner (PHP). Runs the bodies that no recipe step reaches, the generated-method and the fixed-clock
// bodies (tests/conformance/README.md), and prints the document of packages/go/internal/conformance/main.go.
// Usage: php packages/php/testing/conformance/runner.php --dsn URI [--vector NAME]...
// --vector can be repeated; when given, only the vectors with that name run. An unknown name is an error.
declare(strict_types=1);

require dirname(__DIR__, 2) . '/tests/autoload.php';
require __DIR__ . '/result_php_helpers.php';
require dirname(__DIR__, 2) . '/testing/Faults.php';
require __DIR__ . '/runner_functions.php';

use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Tests\Model\ClockCell;
use Polyspec\Orm\Tests\Model\HexCell;
use Polyspec\Orm\Tests\Model\Service;
use Polyspec\Orm\Tests\Model\ServiceMember;
use Polyspec\Orm\Tests\Model\UpsertCell;
use Polyspec\Orm\Config;
use Polyspec\Orm\Model;
use Polyspec\Orm\Orm;
use Polyspec\Orm\StatementEvent;
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
$activeVector = '';

$db = \Polyspec\Orm\Tests\Model\connect($dsn, new Config(
    aesKey: 'bench-salt',
    blindIndexKey: 'bench-blind-index',
    auditSource: static fn(): array => [],
));
$db->transaction(static function (): void {
}, retry: 0);
$db->subscribe(static function (StatementEvent $e): void {
    global $activeVector, $log, $transactions;
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
    ['now_defaults', 'delete_recursive', 'affected_counts', 'clock_truncate_write', 'clock_compare_six_digits'],
    true
);

$author = static fn(): Author => (new Author())->connect($db);
$cols = ['seq', 'name', 'is_close', 'is_display', 'read_count'];

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

vector(
    'relation_empty',
    fn() => count($author()->relations((new ServiceMember())->matchUserSeqWithUserSeq())->getsBySeq(-1))
);
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

vector('aes_values', function () use ($author): array {
    $row = $author()->removeAllColumns()->addColumnAesHexEmail()->addColumnAesHexPhone()->getBySeq(42);
    return ['row' => $row->toArray(), 'found' => $author()->aesHexEmail('user42@example.com')->getCount()];
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

// the seed stores raw hex cells that no encoder writes (benchmarks/sql/seed.*.sql)
vector('hex_malformed', fn(): array => [
    'white_space' => caught(fn() => (new HexCell())($db)->getBySeq(1)),
    'odd_length' => caught(fn() => (new HexCell())($db)->getBySeq(2)),
]);

// A write counts each written row once (docs/spec/protocol.md "Write"): an upsert is 1 whether it inserts or updates,
// and an update counts the row it matched even when the row already holds the value. The count is read through the test
// entry point (docs/spec/protocol.md "Test write result").
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
        'at6_fixed' => $at6->format('Y-m-d H:i:s.u') === '2026-06-01 12:34:56.999999',
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
