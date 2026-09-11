<?php
// Conformance runner (PHP). Same chains as runner_go/main.go and conformance.rs; prints the same document.
// Usage: php tests/conformance/runner.php /abs/ormd.sock /abs/schema.json [--driver mysql|postgres|sqlite] [--dsn …]
// The defaults are the Go runner's: mysql on the local socket (ORM_MYSQL_DSN_PHP in CI), the local PostgreSQL
// of deploy/local-postgres.md, the seeded /tmp/orm_bench.sqlite. ormd must run with the matching -dialect.
declare(strict_types=1);

require dirname(__DIR__, 2) . '/clients/php/tests/autoload.php';

use App\Orm\Battle;
use App\Orm\BattleCols;
use App\Orm\BattleRow;
use App\Orm\BattleWhere;
use App\Orm\Service;
use App\Orm\ServiceMember;
use App\Orm\ServiceMemberRow;
use App\Orm\ServiceModule;
use App\Orm\ServiceWhere;
use App\Orm\User;
use App\Orm\UserWhere;
use Orm\Collection;
use Orm\Config;
use Orm\Orm;
use Orm\OrmException;
use Orm\Q;
use Orm\Tx;

$sock = $argv[1] ?? die("usage: runner.php /abs/ormd.sock /abs/schema.json [--driver mysql|postgres|sqlite] [--dsn …]\n");
$schema = $argv[2] ?? die("schema.json required\n");
$driver = 'mysql';
$dsn = null;
for ($i = 3; $i < $argc; $i++) {
    switch ($argv[$i]) {
        case '--driver':
            $driver = $argv[++$i] ?? die("--driver needs a value\n");
            break;
        case '--dsn':
            $dsn = $argv[++$i] ?? die("--dsn needs a value\n");
            break;
        default:
            die("unknown argument {$argv[$i]}\n");
    }
}

$log = [];
/** @var list<int> PKs created by the running vector; every bind equal to one prints as $SEQ */
$maskSeqs = [];
$maskTs = '';

function fmtTime(string $s): string
{
    return str_ends_with($s, '.000000') ? substr($s, 0, -7) : $s;
}

function norm(mixed $v): mixed
{
    global $maskSeqs, $maskTs, $driver;
    if (is_int($v) && in_array($v, $maskSeqs, true)) {
        return '$SEQ';
    }
    if (is_string($v) && $maskTs !== '' && $v === $maskTs) {
        return '$TS';
    }
    if (is_string($v) && $v !== '' && $v[0] === "\x78" && !ctype_print($v)) { // zlib stream (gz style)
        return '$ZLIB';
    }
    if ($driver !== 'sqlite' && is_string($v) && preg_match('/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d{6})?$/', $v)) {
        return fmtTime($v); // the datetime the Go runner binds as time.Time; on SQLite every runner binds the six-digit text as it is
    }
    return $v;
}

Orm::init(new Config(socket: $sock, schemaPath: $schema, aesKey: 'bench-salt', driver: $driver,
    onQuery: function (string $sql, array $binds, float $sec, string $planId, ?\Throwable $e) use (&$log) {
        $log[] = ['sql' => $sql, 'binds' => array_map('norm', $binds)];
    }));
$db = orm_open_db($driver, $dsn ?? orm_default_dsn($driver));

$out = [];
$run = function (string $name, \Closure $fn) use (&$out, &$log, &$maskSeqs, &$maskTs): void {
    $log = [];
    $maskSeqs = [];
    $maskTs = '';
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
// Statements logged before the created row was known are re-masked once its seq/updated_ts are.
$remask = function (array $seqs, string $ts) use (&$log, &$maskSeqs, &$maskTs): void {
    $maskSeqs = $seqs;
    $maskTs = $ts;
    foreach ($log as &$st) {
        $st['binds'] = array_map('norm', $st['binds']);
    }
    unset($st);
};
$run('write_cycle', function () use ($db, $remask) {
    $created = $db->transaction(fn(Tx $tx) => (new Battle)
        ->setName('conf-write')
        ->setUserSeq(1)->setServiceSeq(999)->setServiceModuleSeq(1)->setServiceMemberSeq(1)
        ->setStartDt('2026-06-01 00:00:00')->setEndDt('2026-12-31 00:00:00')
        ->setAesHexEmail('w@example.com')
        ->insert($tx));
    $remask([$created->getSeq()], $created->getUpdatedTs());
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
$run('expr_where', fn() => (new Battle)->serviceSeqEq(7)->expr('LENGTH(`name`) > ?', [8])->count($db));
$run('select_expr', function () use ($db) {
    $b = (new Battle)->selectExpr('tag', "CONCAT(`name`, '!')")->seqEq(42)->one($db);
    return ['seq' => $b->getSeq(), 'tag' => $b['tag']];
});
$run('relation_four_levels', fn() => (new Battle)->selectNone()->seqEq(7)
    ->relationService((new Service)
        ->relationsMembers((new ServiceMember)->orderBySeqAsc()->limitPerParent(2)
            ->relationUser((new User)
                ->relationsBattles((new Battle)->selectNone()->orderBySeqAsc()->limitPerParent(1)))))
    ->one($db)->toArray());
$run('relation_one_ordered', fn() => (new Battle)->selectNone()->seqEq(7)->relationService((new Service)->orderBySeqDesc())->one($db)->toArray());
$run('relation_if_parent', function () use ($db) {
    $items = [];
    foreach ((new Battle)->selectNone()->seqIn([7, 8, 14])->orderBySeqAsc()->relationUser((new User)->ifParentIsCloseEq(true))->all($db) as $b) {
        $items[] = $b->toArray();
    }
    return $items;
});
$run('relation_empty_parents', fn() => $keys((new Battle)->seqEq(0)->relationUser(new User)->all($db)));
$run('relation_off_join', fn() => (new Battle)->selectNone()->seqEq(8)->joinService((new Service)->relationsModules(new ServiceModule))->one($db)->toArray());
$run('paginate_relations', function () use ($db) {
    $p = (new Battle)->selectNone()->serviceSeqEq(7)->orderBySeqAsc()->relationUser(new User)->paginate($db, 1, 3);
    $items = [];
    foreach ($p->items as $b) {
        $items[] = $b->toArray();
    }
    return ['total' => $p->total, 'items' => $items];
});
$run('key_by_column', fn() => (new Service)->seqEq(7)->relationsMembers((new ServiceMember)->orderBySeqAsc()->limitPerParent(3)->keyByUserSeq())->one($db)->toArray());
$run('key_by_unselected', fn() => (new Service)->seqEq(7)->relationsModules((new ServiceModule)->selectNone()->keyByName())->one($db)->toArray());
$run('types_roundtrip', function () use ($db, $remask) {
    $dt = '2026-06-01 12:34:56.123456';
    $created = $db->transaction(fn(Tx $tx) => (new Battle)
        ->setName('conf-types')
        ->setUserSeq(1)->setServiceSeq(999)->setServiceModuleSeq(1)->setServiceMemberSeq(1)
        ->setStartDt($dt)->setEndDt($dt)->setDisplayStartDt($dt)->setIsDisplay(true)->setTargetTeamPlayerCount(2147483647)->setReadCount(4294967295)->setPrice(12345.678)
        ->setJsonSetting(['k' => []])->setJsonsTags([])->setSerializeData('')
        ->insert($tx));
    $remask([$created->getSeq()], $created->getUpdatedTs());
    $b = (new Battle)->selectJsonSetting()->selectJsonsTags()->selectSerializeData()->seqEq($created->getSeq())->one($db);
    $b->delete($db);
    return [
        'display_start_dt' => fmtTime($b->getDisplayStartDt()), 'is_display' => $b->getIsDisplay(), 'is_close' => $b->getIsClose(),
        'target_team_player_count' => $b->getTargetTeamPlayerCount(), 'read_count' => $b->getReadCount(), 'price' => $b->getPrice(),
        'json_setting' => $b->getJsonSetting(), 'jsons_tags' => $b->getJsonsTags(), 'serialize_data' => $b->getSerializeData(),
    ];
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
$fks = fn(Battle $q): Battle => $q
    ->setUserSeq(1)->setServiceSeq(999)->setServiceModuleSeq(1)->setServiceMemberSeq(1)
    ->setStartDt('2026-06-01 00:00:00')->setEndDt('2026-12-31 00:00:00');
$run('upsert', function () use ($db, $fks, $remask) {
    $a = null;
    $b = $db->transaction(function (Tx $tx) use ($fks, &$a) {
        $a = $fks((new Battle)->setUuid('conf-upsert')->setName('u1')->setReadCount(1))->insert($tx);
        $b = $fks((new Battle)->setUuid('conf-upsert')->setName('u2')->setReadCount(1))
            ->onDuplicateSetName('u2')->onDuplicatePlusReadCount(5)
            ->insert($tx);
        $b->delete($tx);
        return $b;
    });
    $remask([$a->getSeq()], $b->getUpdatedTs());
    return ['same_seq' => $a->getSeq() === $b->getSeq(), 'name' => $b->getName(), 'read_count' => $b->getReadCount()];
});
$run('upsert_set_all', function () use ($db, $fks, $remask) {
    $a = null;
    $b = $db->transaction(function (Tx $tx) use ($fks, &$a) {
        $a = $fks((new Battle)->setUuid('conf-upsert')->setName('u1')->setReadCount(1))->insert($tx);
        $b = $fks((new Battle)->setUuid('conf-upsert')->setName('u3')->setReadCount(9))->onDuplicateSetAll()->insert($tx);
        $b->delete($tx);
        return $b;
    });
    $remask([$a->getSeq()], $b->getUpdatedTs());
    return ['same_seq' => $a->getSeq() === $b->getSeq(), 'name' => $b->getName(), 'read_count' => $b->getReadCount()];
});
$run('save_branch', function () use ($db, $fks, $remask) {
    $r = $db->transaction(fn(Tx $tx) => $fks((new Battle)->setName('conf-save'))->save($tx));
    $remask([$r->getSeq()], $r->getUpdatedTs());
    // save() re-reads the row after its UPDATE; that SELECT is the read-back.
    $after = (new Battle)->setSeq($r->getSeq())->setName('conf-save-2')->save($db);
    $after->delete($db);
    return ['inserted' => $r->getSeq() > 0, 'after' => $after->getName()];
});
$run('bulk_update_plus_minus', function () use ($db, $fks, $remask) {
    $r = $db->transaction(fn(Tx $tx) => $fks((new Battle)->setReadCount(3)->setName('conf-bulk'))->insert($tx));
    $remask([$r->getSeq()], $r->getUpdatedTs());
    $seq = $r->getSeq();
    $read = fn(): int => (new Battle)->oneBySeq($db, $seq)->getReadCount();
    (new Battle)->seqEq($seq)->plusReadCount(2)->update($db);
    $afterPlus = $read();
    (new Battle)->seqEq($seq)->minusReadCount(10)->update($db);
    $afterMinus = $read();
    (new Battle)->seqEq($seq)->setReadCountExpr('`read_count` * ? + 1', [2])->update($db);
    $afterExpr = $read();
    $deleted = (new Battle)->seqEq($seq)->delete($db);
    return ['after_plus' => $afterPlus, 'after_minus' => $afterMinus, 'after_expr' => $afterExpr, 'deleted' => $deleted];
});
$run('delete_cascade_order', function () use ($db, $remask) {
    [$s, $mod, $seqs] = $db->transaction(function (Tx $tx) {
        $s = (new Service)->setName('conf-svc')->insert($tx);
        $m1 = (new ServiceMember)->setServiceSeq($s->getSeq())->setUserSeq(1)->insert($tx);
        $m2 = (new ServiceMember)->setServiceSeq($s->getSeq())->setUserSeq(2)->insert($tx);
        $mod = (new ServiceModule)->setServiceSeq($s->getSeq())->setName('conf-mod')->insert($tx);
        return [$s, $mod, [$s->getSeq(), $m1->getSeq(), $m2->getSeq(), $mod->getSeq()]];
    });
    $remask($seqs, '');
    (new Service)->seqEq($s->getSeq())
        ->relationsMembers((new ServiceMember)->orderBySeqAsc())
        ->relationsModules((new ServiceModule)->noCascadeDelete())
        ->one($db)
        ->deleteCascade($db);
    $left = [
        'members_left' => (new ServiceMember)->serviceSeqEq($s->getSeq())->count($db),
        'modules_left' => (new ServiceModule)->serviceSeqEq($s->getSeq())->count($db),
        'service_left' => (new Service)->seqEq($s->getSeq())->count($db),
    ];
    (new ServiceModule)->seqEq($mod->getSeq())->delete($db);
    return $left;
});
$run('sql_dump', fn() => (new Battle)->serviceSeqEq(7)->selectAesHexEmail()->limit(0, 1)->sql($db));
$run('agg_min_max', fn() => [
    'min' => (new Battle)->serviceSeqEq(7)->minSeq($db),
    'max' => (new Battle)->serviceSeqEq(7)->maxSeq($db),
    'distinct_users' => (new Battle)->serviceSeqEq(7)->countDistinctUserSeq($db),
]);
$run('group_count_having', fn() => (new Battle)->serviceSeqEq(7)->groupByUserSeq()->having(fn(BattleWhere $w) => $w->expr('COUNT(*) > ?', [1]))->count($db));
$run('predicate_named', fn() => [
    'visible' => (new Battle)->visible()->serviceSeqEq(7)->count($db),
    'started_after' => (new Battle)->startedAfter('2026-01-01 00:00:00')->serviceSeqEq(7)->count($db),
]);
$run('raw_root', fn() => (new Battle)->raw('SELECT COUNT(*) AS n, MAX(seq) AS m FROM {table} WHERE service_seq = ? AND is_close = ?', [7, false])->rawAll($db));
$run('join_fulltext_or', fn() => (new Battle)
    ->joinService((new Service)->where(fn(ServiceWhere $w) => $w->seqEq(7)))
    ->isCloseEq(false)
    ->and(fn(BattleWhere $w) => $w
        ->nameWithDescriptionMatchBoolean('battle')
        ->or()
        ->service(fn(ServiceWhere $s) => $s->nameEq('service-999')))
    ->count($db));
$run('join_two_groups', fn() => (new Battle)
    ->joinService((new Service)->on(fn(ServiceWhere $w) => $w->nameEq('service-7'))->where(fn(ServiceWhere $w) => $w->seqGt(0)))
    ->leftJoinUser((new User)->where(fn(UserWhere $w) => $w->nameContains('user-4')))
    ->seqIn([6, 106, 206, 406])
    ->count($db));
$run('join_multi_level', fn() => (new Battle)->selectNone()->seqEq(6)
    ->joinServiceMember((new ServiceMember)->selectNone()
        ->joinUser((new User)->selectNone())
        ->joinService((new Service)->selectNone()))
    ->one($db)->toArray());
$run('codec_roundtrip', function () use ($db, $remask) {
    $value = ['a' => 1, 'b' => [1, 2, ['c' => '한글/slash']], 'd' => null, 'e' => true, 'f' => 1.5];
    $created = $db->transaction(fn(Tx $tx) => (new Battle)
        ->setName('conf-codec')
        ->setUserSeq(1)->setServiceSeq(999)->setServiceModuleSeq(1)->setServiceMemberSeq(1)
        ->setStartDt('2026-06-01 00:00:00')->setEndDt('2026-12-31 00:00:00')
        ->setJsonSetting($value)->setJsonsTags(['x', 'y'])->setBase64Extra($value)->setSerializeData($value)->setGzExtend($value)->setIp('10.1.2.3')
        ->insert($tx));
    $remask([$created->getSeq()], $created->getUpdatedTs());
    $b = (new Battle)->selectJsonSetting()->selectJsonsTags()->selectBase64Extra()->selectSerializeData()->selectGzExtend()->seqEq($created->getSeq())->one($db);
    $b->delete($db);
    return ['json_setting' => $b->getJsonSetting(), 'jsons_tags' => $b->getJsonsTags(), 'base64_extra' => $b->getBase64Extra(), 'serialize_data' => $b->getSerializeData(), 'gz_extend' => $b->getGzExtend(), 'ip' => $b->getIp()];
});

// packed ip binds (SQLite) are raw bytes: substituted rather than fatal, as Go's encoder does
echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR), "\n";
