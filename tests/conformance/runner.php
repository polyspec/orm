<?php
// Conformance runner (PHP). Same chains as runner_go/main.go and conformance.rs; prints the same document.
// Usage: php tests/conformance/runner.php /abs/ormd.sock /abs/schema.json
declare(strict_types=1);

require dirname(__DIR__, 2) . '/clients/php/tests/autoload.php';

use App\Orm\Battle;
use App\Orm\BattleCols;
use App\Orm\BattleRow;
use App\Orm\BattleWhere;
use App\Orm\Service;
use App\Orm\ServiceMember;
use App\Orm\ServiceMemberRow;
use App\Orm\ServiceWhere;
use App\Orm\User;
use App\Orm\UserWhere;
use Orm\Collection;
use Orm\Config;
use Orm\Db;
use Orm\Orm;
use Orm\OrmException;
use Orm\Q;
use Orm\Tx;

$sock = $argv[1] ?? die("usage: runner.php /abs/ormd.sock /abs/schema.json\n");
$schema = $argv[2] ?? die("schema.json required\n");

$log = [];
$maskSeq = 0;
$maskTs = '';

function fmtTime(string $s): string
{
    return str_ends_with($s, '.000000') ? substr($s, 0, -7) : $s;
}

function norm(mixed $v): mixed
{
    global $maskSeq, $maskTs;
    if (is_int($v) && $maskSeq !== 0 && $v === $maskSeq) {
        return '$SEQ';
    }
    if (is_string($v) && $maskTs !== '' && $v === $maskTs) {
        return '$TS';
    }
    if (is_string($v) && $v !== '' && $v[0] === "\x78" && !ctype_print($v)) { // zlib stream (gz style)
        return '$ZLIB';
    }
    if (is_string($v) && preg_match('/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d{6})?$/', $v)) {
        return fmtTime($v);
    }
    return $v;
}

Orm::init(new Config(socket: $sock, schemaPath: $schema, aesKey: 'bench-salt',
    onQuery: function (string $sql, array $args, float $sec, ?\Throwable $e) use (&$log) {
        $log[] = ['sql' => $sql, 'binds' => array_map('norm', $args)];
    }));
$db = Db::mysql('mysql:unix_socket=/tmp/mysql.sock;dbname=orm_bench;charset=utf8mb4', 'root', '');

$out = [];
$run = function (string $name, \Closure $fn) use (&$out, &$log): void {
    $log = [];
    try {
        $res = $fn();
    } catch (OrmException $e) {
        $res = ['error' => $e->code_];
    }
    $out[$name] = ['statements' => $log, 'result' => $res];
};
$row = fn(?BattleRow $b): ?array => $b === null ? null : [
    'seq' => $b->getSeq(), 'name' => $b->getName(), 'aes_hex_email' => $b->getAesHexEmail(), 'is_close' => $b->getIsClose(), 'is_display' => $b->getIsDisplay(),
    'description' => $b->getDescription(), 'start_dt' => fmtTime($b->getStartDt()), 'like_count' => $b->getLikeCount(),
];
$keyed = function (Collection $c): array {
    $items = [];
    foreach ($c as $k => $r) {
        $items[] = [$k, ['seq' => $r->getSeq(), 'name' => $r->getName(), 'like_count' => $r->getLikeCount()]];
    }
    return $items;
};
$keys = fn(Collection $c): array => $c->keys();
$now = '2026-09-11 00:00:00';

$run('pk_one', fn() => $row((new Battle)->seqEq(42)->one($db)));
$run('pk_one_by', fn() => $row((new Battle)->oneBySeq($db, 42)));
$run('pk_missing', fn() => $row((new Battle)->seqEq(0)->one($db)));
$run('select_lazy', function () use ($db) {
    $b = (new Battle)->selectDescription()->seqEq(42)->one($db);
    return ['seq' => $b->getSeq(), 'description_prefix' => substr((string) $b->getDescription(), 0, 7)];
});
$run('list_order_limit', fn() => $keyed((new Battle)->serviceSeqEq(7)->isCloseEq(false)->orderBySeqDesc()->limit(0, 5)->all($db)));
$run('in_keyed', fn() => $keys((new Battle)->seqIn([306, 6, 106])->orderBySeqAsc()->all($db)));
$run('group_or', fn() => $keyed((new Battle)
    ->serviceSeqEq(7)
    ->isCloseEq(false)
    ->and(fn(BattleWhere $w) => $w
        ->isDisplayEq(true)
        ->or()
        ->and(fn(BattleWhere $w) => $w->isDisplayEq(false)->displayStartDtLt($now)))
    ->seqIn([6, 106, 206, 306, 406])
    ->orderBySeqDesc()
    ->limit(0, 3)
    ->all($db)));
$run('aggregates', fn() => [
    'count' => (new Battle)->serviceSeqEq(7)->count($db),
    'sum_like_count' => (new Battle)->serviceSeqEq(7)->sumLikeCount($db),
    'avg_like_count' => (new Battle)->serviceSeqEq(7)->avgLikeCount($db),
]);
$run('join_nav_count', fn() => (new Battle)
    ->joinService((new Service)->where(fn(ServiceWhere $w) => $w->nameEq('service-7')))
    ->leftJoinUser((new User)->on(fn(UserWhere $w) => $w->nameContains('user')))
    ->isCloseEq(false)
    ->and(fn(BattleWhere $w) => $w->isDisplayEq(true)->or()->service(fn(ServiceWhere $s) => $s->seqGt(1000)))
    ->count($db));
$run('join_row', function () use ($db) {
    $b = (new Battle)->joinService((new Service)->where(fn(ServiceWhere $w) => $w->seqEq(7)))->seqEq(6)->one($db);
    return ['seq' => $b->getSeq(), 'service' => ['seq' => $b->getService()->getSeq(), 'name' => $b->getService()->getName()]];
});
$run('paginate', function () use ($db, $keys) {
    $p = (new Battle)->serviceSeqEq(7)->orderBySeqAsc()->paginate($db, 2, 10);
    return ['total' => $p->total, 'pages' => $p->pages, 'current' => $p->current, 'per' => $p->per, 'keys' => $keys($p->items)];
});
$run('contains_escape', fn() => (new Battle)->nameContains('%')->count($db));
$run('empty_in_error', fn() => (new Battle)->seqIn([])->count($db));
$run('op_not_allowed_error', function () use ($db) {
    // Not expressible through the typed builder; the untyped core reaches the engine.
    $q = new Q('battle');
    $q->w()->pred('seq', 'like', 'x');
    return $q->runScalar($db, 'count');
});
$run('write_cycle', function () use ($db, &$log, &$maskSeq, &$maskTs) {
    $created = $db->transaction(fn(Tx $tx) => (new Battle)
        ->setName('conf-write')
        ->setUserSeq(1)->setServiceSeq(999)->setServiceModuleSeq(1)->setServiceMemberSeq(1)
        ->setStartDt('2026-06-01 00:00:00')->setEndDt('2026-12-31 00:00:00')
        ->setAesHexEmail('w@example.com')
        ->insert($tx));
    $maskSeq = $created->getSeq();
    $maskTs = $created->getUpdatedTs();
    foreach ($log as &$st) {
        $st['binds'] = array_map('norm', $st['binds']);
    }
    unset($st);
    $created->setName('conf-write-2')->setLikeCount(5)->updateOptimistic($db);
    $again = (new Battle)->oneBySeq($db, $created->getSeq());
    try {
        $created->setName('stale')->updateOptimistic($db);
        $stale = null;
    } catch (OrmException $e) {
        $stale = $e->code_;
    }
    $again->delete($db);
    $left = (new Battle)->seqEq($created->getSeq())->count($db);
    return [
        'inserted' => $created->getSeq() > 0, 'email' => $created->getAesHexEmail(),
        'after_update' => ['name' => $again->getName(), 'like_count' => $again->getLikeCount()],
        'stale' => $stale, 'left' => $left,
    ];
});

$run('eq_col_where', fn() => $keys((new Battle)
    ->joinService((new Service)->where(fn(ServiceWhere $w) => $w->seqEqCol(BattleCols::serviceModuleSeq())))
    ->seqIn([1, 2, 10])->orderBySeqAsc()->all($db)));
$run('expr_where', fn() => (new Battle)->serviceSeqEq(7)->expr('DAYOFMONTH(`start_dt`) = ?', [1])->count($db));
$run('select_expr', function () use ($db) {
    $b = (new Battle)->selectExpr('tag', "CONCAT(`name`, '!')")->seqEq(42)->one($db);
    return ['seq' => $b->getSeq(), 'tag' => $b['tag']];
});
$run('key_by_fn_to_array', function () use ($db) {
    $c = (new ServiceMember)->serviceSeqEq(7)->orderBySeqAsc()->limit(0, 2)
        ->relationUser((new User)->flatten())
        ->keyByFn(fn(ServiceMemberRow $m) => 'u' . $m->getUserSeq())
        ->all($db);
    $items = [];
    foreach ($c as $k => $m) {
        $items[] = [(string) $k, $m->toArray()];
    }
    return $items;
});
$run('drop_child_key_to_array', fn() => (new User)->seqEq(5)->relationsBattles((new Battle)->selectNone()->orderBySeqAsc()->limitPerParent(2)->dropChildKey())->one($db)->toArray());
$run('codec_roundtrip', function () use ($db, &$log, &$maskSeq, &$maskTs) {
    $value = ['a' => 1, 'b' => [1, 2, ['c' => '한글/slash']], 'd' => null, 'e' => true, 'f' => 1.5];
    $created = $db->transaction(fn(Tx $tx) => (new Battle)
        ->setName('conf-codec')
        ->setUserSeq(1)->setServiceSeq(999)->setServiceModuleSeq(1)->setServiceMemberSeq(1)
        ->setStartDt('2026-06-01 00:00:00')->setEndDt('2026-12-31 00:00:00')
        ->setJsonSetting($value)->setJsonsTags(['x', 'y'])->setBase64Extra($value)->setSerializeData($value)->setGzExtend($value)->setIp('10.1.2.3')
        ->insert($tx));
    $maskSeq = $created->getSeq();
    $maskTs = $created->getUpdatedTs();
    foreach ($log as &$st) {
        $st['binds'] = array_map('norm', $st['binds']);
    }
    unset($st);
    $b = (new Battle)->selectJsonSetting()->selectJsonsTags()->selectBase64Extra()->selectSerializeData()->selectGzExtend()->seqEq($created->getSeq())->one($db);
    $b->delete($db);
    return ['json_setting' => $b->getJsonSetting(), 'jsons_tags' => $b->getJsonsTags(), 'base64_extra' => $b->getBase64Extra(), 'serialize_data' => $b->getSerializeData(), 'gz_extend' => $b->getGzExtend(), 'ip' => $b->getIp()];
});

echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), "\n";
