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


// Statements logged before the created row was known are re-masked once its seq/updated_ts are.
$remask = function (array $seqs, string $ts) use (&$log, &$maskSeqs, &$maskTs): void {
    $maskSeqs = $seqs;
    $maskTs = $ts;
    foreach ($log as &$st) {
        $st['binds'] = array_map('norm', $st['binds']);
    }
    unset($st);
};

$run('interface_query_reuse', function () use ($db) {
    $q=(new Battle)->bind($db)->serviceSeq(7)->limit(0,2);
    $first=$q->getCount(); $rows=$q->gets(); $last=$q->getCount();
    return [$first,count($rows),$last];
});
$run('interface_attach', function () {
    $child=(new User)->seqIn([1,2])->and(fn(UserWhere $w)=>$w->name('user-1')->or()->name('user-2'));
    $a=(new Battle)->serviceSeq(7)->joinUser($child);
    $b=(new Battle)->serviceSeq(8)->joinUser($child);
    $child->name('later');
    $node=static function ($q) { $ir=$q->req->ir; unset($ir['ir_version'],$ir['schema_hash'],$ir['kind']); return $ir; };
    return ['a'=>$node($a),'b'=>$node($b),'child'=>$node($child),'a_params'=>$a->req->params,'b_params'=>$b->req->params,'child_params'=>$child->req->params];
});
$run('interface_typed_keys', function () {
    $c=new \Orm\Collection();
    foreach ([[1,'first'],['1','string'],[2,'second'],[1,'last']] as [$key,$name]) {
        $c->put($key,(new \App\Orm\ServiceRow)->setName($name));
    }
    $out=[];foreach($c->entries() as $entry){$out[]=[$entry['key'],$entry['value']->getName()];}
    try {$c->toArray();throw new \RuntimeException('mixed keys were silently merged');}
    catch(OrmException $e){if($e->code_!==\Orm\Code::IR_INVALID){throw $e;}}
    return $out;
});
$run('interface_invalid_page', fn()=>(new Battle)->bind($db)->paginate(1,0));
$run('interface_error', function () use ($db) {
    $child=new User; $child->setStyled('name','x',['unsupported']);
    $q=(new Battle)->bind($db)->joinUser($child);
    $errors=[];
    try{$q->sql();$errors[]=null;}catch(OrmException $e){$errors[]=$e->code_;}
    try{$q->sql();$errors[]=null;}catch(OrmException $e){$errors[]=$e->code_;}
    return $errors;
});
$run('interface_row_state', function () use ($db) {
    global $log;
    $result=null; $rollback=new \RuntimeException('interface rollback');
    try {$db->transaction(function(Tx $tx)use(&$result,$rollback,&$log){
        $r=(new Battle)->bind($tx)->selectNone()->selectSeq()->getBySeq(6);
        $before=$r->has('name');
        $r->setName('interface-first')->setLikeCount(5)->setName('interface-final');
        $r->update();$n=count($log);$r->update();
        $result=['before'=>$before,'assigned'=>$r->has('name'),'value'=>$r->getName(),'export'=>$r->toArray(),'noop_statements'=>count($log)-$n,'relation_loaded'=>$r->relLoaded('user')];
        throw $rollback;
    });}catch(\Throwable $e){if($e!==$rollback){throw $e;}}
    return $result;
});
$run('interface_dirty_retry', function () use ($db,$remask) {
    $result=null;$rollback=new \RuntimeException('interface rollback');
    try {$db->transaction(function(Tx $tx)use(&$result,$rollback,$remask){
        $r=(new Battle)->bind($tx)->getBySeq(6);$remask([],$r->getUpdatedTs());
        (new Battle)->bind($tx)->seq(6)->setUpdatedTs('2001-01-01 00:00:00')->update();
        $r->setName('interface-pending');
        $errors=[];
        try{$r->updateOptimistic();$errors[]=null;}catch(OrmException $e){$errors[]=$e->code_;}
        try{$r->updateOptimistic();$errors[]=null;}catch(OrmException $e){$errors[]=$e->code_;}
        $result=['errors'=>$errors,'value'=>$r->getName()];throw $rollback;
    });}catch(\Throwable $e){if($e!==$rollback){throw $e;}}
    return $result;
});

$run('interface_original_version', function () use ($db,$remask) {
    $result=null;$rollback=new \RuntimeException('interface rollback');
    try {$db->transaction(function(Tx $tx)use(&$result,$rollback,$remask){
        $r=(new Battle)->bind($tx)->getBySeq(6);$remask([],$r->getUpdatedTs());
        $version='2002-01-01 00:00:00';
        $r->setUpdatedTs($version)->setName('interface-version');$r->updateOptimistic();
        $sparse=(new Battle)->bind($tx)->selectNone()->selectSeq()->getBySeq(6);$sparse->setName('not-written');
        $missing=null;try{$sparse->updateOptimistic();}catch(OrmException $e){$missing=$e->code_;}
        $stored=(new Battle)->bind($tx)->getBySeq(6);
        $result=['name'=>$stored->getName(),'version_retained'=>str_starts_with($r->getUpdatedTs(),$version)&&str_starts_with($stored->getUpdatedTs(),$version),'missing_version'=>$missing,'pending'=>$sparse->getName()];
        throw $rollback;
    });}catch(\Throwable $e){if($e!==$rollback){throw $e;}}
    return $result;
});
$run('interface_identity', function () use ($db) {
    $result=null;$rollback=new \RuntimeException('interface rollback');
    try {$db->transaction(function(Tx $tx)use(&$result,$rollback){
        $r=(new Battle)->bind($tx)->getBySeq(6);
        // Mutate native value storage without invoking a setter, as public fields do in Go/Rust.
        $values=new \ReflectionProperty(\Orm\Row::class,'vals');$index=new \ReflectionProperty(\Orm\Row::class,'idx');
        $v=$values->getValue($r);$v[$index->getValue($r)['seq']]=5;$values->setValue($r,$v);
        $r->setName('identity-original');$r->update();
        $stored=(new Battle)->bind($tx)->getBySeq(6);$r->delete();
        $original=(new Battle)->bind($tx)->getCountBySeq(6);$other=(new Battle)->bind($tx)->getCountBySeq(5);
        $result=['updated'=>$stored->getName(),'original_left'=>$original,'other_left'=>$other];throw $rollback;
    });}catch(\Throwable $e){if($e!==$rollback){throw $e;}}return $result;
});
$run('interface_nested_keys', function () use ($db) {
    $r=(new Service)->bind($db)->relationsMembers((new ServiceMember)->orderBySeqAsc()->limitPerParent(1))->getBySeq(7);
    $members=$r->getMembers();$first=$members->first();$members->put(1,$first);$members->put('1',$first);
    return $r->toArray();
});
$run('unbound_terminal', fn() => (new Battle)->getCountByServiceSeq(7));
$run('bound_count_finder', fn() => (new Battle)->bind($db)
    ->joinService((new Service)->where(fn(ServiceWhere $w) => $w->name('service-7')))
    ->relationUser(new User)->getCountByServiceSeq(7));
$run('finished_transaction', function () use ($db) {
    $q = $db->transaction(fn(Tx $tx) => (new Battle)->bind($tx));
    return $q->getCountByServiceSeq(7);
});
$run('bound_transaction_rollback', function () use ($db, $remask) {
    $rollback = new \RuntimeException('binding rollback');
    $s = $m = null;
    $changed = 0;
    $joinedName = '';
    try {
        $db->transaction(function (Tx $tx) use ($db, $rollback, &$s, &$m, &$changed, &$joinedName) {
            $s = (new Service)->bind($tx)->setName('conf-bind')->insert();
            $s->setName('conf-bound')->update();
            $m = (new ServiceMember)->bind($tx)->setServiceSeq($s->getSeq())->setUserSeq(1)->insert();
            $parent = (new Service)->bind($db)->bind($tx)
                ->relationsMembers((new ServiceMember)->bind($db)->joinUser(new User))->getBySeq($s->getSeq());
            if ($parent === null || $parent->getName() !== 'conf-bound' || count($parent->getMembers()) !== 1) {
                throw new \RuntimeException('bound relation missing');
            }
            $child = $parent->getMembers()->first();
            $child->setUserSeq(2)->update();
            $child->getUser()->setName('conf-user')->update();
            $changed = (new ServiceMember)->bind($tx)->userSeq(2)->getCountByServiceSeq($s->getSeq());
            $u = (new User)->bind($tx)->getBySeq(1);
            $joinedName = $u->getName();
            throw $rollback;
        });
    } catch (\Throwable $e) {
        if ($e !== $rollback) { throw $e; }
    }
    $remask([$s->getSeq(), $m->getSeq()], '');
    $expired = null;
    try { $m->delete(); } catch (OrmException $e) { $expired = $e->code_; }
    $membersLeft = (new ServiceMember)->bind($db)->getCountByServiceSeq($s->getSeq());
    $serviceLeft = (new Service)->bind($db)->getCountBySeq($s->getSeq());
    $u = (new User)->bind($db)->getBySeq(1);
    return ['changed' => $changed, 'joined_name' => $joinedName, 'expired_row' => $expired,
        'members_left' => $membersLeft, 'service_left' => $serviceLeft, 'user_name' => $u->getName()];
});

$run('pk_one', fn() => $row((new Battle)->seq(42)->bind($db)->get()));
$run('pk_one_by', fn() => $row((new Battle)->bind($db)->getBySeq(42)));
$run('pk_missing', fn() => $row((new Battle)->seq(0)->bind($db)->get()));
$run('select_lazy', function () use ($db) {
    $b = (new Battle)->selectDescription()->seq(42)->bind($db)->get();
    return ['seq' => $b->getSeq(), 'description_prefix' => substr((string) $b->getDescription(), 0, 7)];
});
$run('list_order_limit', fn() => $keyed((new Battle)->serviceSeq(7)->isClose(false)->orderBySeqDesc()->limit(0, 5)->bind($db)->gets()));
$run('in_keyed', fn() => $keys((new Battle)->seqIn([306, 6, 106])->orderBySeqAsc()->bind($db)->gets()));
$run('group_or', fn() => $keyed((new Battle)
    ->serviceSeq(7)
    ->isClose(false)
    ->and(fn(BattleWhere $w) => $w
        ->isDisplay(true)
        ->or()
        ->and(fn(BattleWhere $w) => $w->isDisplay(false)->displayStartDtLt($now)))
    ->seqIn([6, 106, 206, 306, 406])
    ->orderBySeqDesc()
    ->limit(0, 3)
    ->bind($db)->gets()));
$run('aggregates', fn() => [
    'count' => (new Battle)->serviceSeq(7)->bind($db)->getCount(),
    'sum_like_count' => (new Battle)->serviceSeq(7)->bind($db)->sumLikeCount(),
    'avg_like_count' => (new Battle)->serviceSeq(7)->bind($db)->avgLikeCount(),
]);
$run('join_nav_count', fn() => (new Battle)
    ->joinService((new Service)->where(fn(ServiceWhere $w) => $w->name('service-7')))
    ->leftJoinUser((new User)->on(fn(UserWhere $w) => $w->nameContains('user')))
    ->isClose(false)
    ->and(fn(BattleWhere $w) => $w->isDisplay(true)->or()->service(fn(ServiceWhere $s) => $s->seqGt(1000)))
    ->bind($db)->getCount());
$run('join_row', function () use ($db) {
    $b = (new Battle)->joinService((new Service)->where(fn(ServiceWhere $w) => $w->seq(7)))->seq(6)->bind($db)->get();
    return ['seq' => $b->getSeq(), 'service' => ['seq' => $b->getService()->getSeq(), 'name' => $b->getService()->getName()]];
});
$run('root_finder_join_relation', function () use ($db) {
    $rows = (new Battle)->selectNone()
        ->joinService((new Service)->where(fn(ServiceWhere $w) => $w->name('service-7')))
        ->relationUser(new User)->orderBySeqAsc()->limit(0, 2)
        ->bind($db)->getsByServiceSeq(7);
    $items = [];
    foreach ($rows as $b) {
        $items[] = [
            'seq' => $b->getSeq(),
            'service' => ['seq' => $b->getService()->getSeq(), 'name' => $b->getService()->getName()],
            'user' => ['seq' => $b->getUser()->getSeq(), 'name' => $b->getUser()->getName()],
        ];
    }
    return $items;
});
$run('paginate', function () use ($db, $keys) {
    $p = (new Battle)->serviceSeq(7)->orderBySeqAsc()->bind($db)->paginate(2, 10);
    return ['total' => $p->total, 'pages' => $p->pages, 'current' => $p->current, 'per' => $p->per, 'keys' => $keys($p->items)];
});
$run('contains_escape', fn() => (new Battle)->nameContains('%')->bind($db)->getCount());
$run('empty_in_error', fn() => (new Battle)->seqIn([])->bind($db)->getCount());
$run('op_not_allowed_error', function () use ($db) {
    // Not expressible through the typed builder; the untyped core reaches the engine.
    $q = new Q('battle');
    $q->w()->pred('seq', 'like', 'x');
    return $q->runScalar($db, 'count');
});
$run('write_cycle', function () use ($db, $remask) {
    $created = $db->transaction(fn(Tx $tx) => (new Battle)
        ->setName('conf-write')
        ->setUserSeq(1)->setServiceSeq(999)->setServiceModuleSeq(1)->setServiceMemberSeq(1)
        ->setStartDt('2026-06-01 00:00:00')->setEndDt('2026-12-31 00:00:00')
        ->setAesHexEmail('w@example.com')
        ->bind($tx)->insert());
    $remask([$created->getSeq()], $created->getUpdatedTs());
    $created->setName('conf-write-2')->setLikeCount(5)->bind($db)->updateOptimistic();
    $again = (new Battle)->bind($db)->oneBySeq($created->getSeq());
    try {
        $created->setName('stale')->bind($db)->updateOptimistic();
        $stale = null;
    } catch (OrmException $e) {
        $stale = $e->code_;
    }
    $again->delete();
    $left = (new Battle)->seq($created->getSeq())->bind($db)->getCount();
    return [
        'inserted' => $created->getSeq() > 0, 'email' => $created->getAesHexEmail(),
        'after_update' => ['name' => $again->getName(), 'like_count' => $again->getLikeCount()],
        'stale' => $stale, 'left' => $left,
    ];
});

$run('eq_col_where', fn() => $keys((new Battle)
    ->joinService((new Service)->where(fn(ServiceWhere $w) => $w->seqEqCol(BattleCols::serviceModuleSeq())))
    ->seqIn([1, 2, 10])->orderBySeqAsc()->bind($db)->gets()));
$run('expr_where', fn() => (new Battle)->serviceSeq(7)->expr('LENGTH(`name`) > ?', [8])->bind($db)->getCount());
$run('select_expr', function () use ($db) {
    $b = (new Battle)->selectExpr('tag', "CONCAT(`name`, '!')")->seq(42)->bind($db)->get();
    return ['seq' => $b->getSeq(), 'tag' => $b['tag']];
});
$run('relation_four_levels', fn() => (new Battle)->selectNone()->seq(7)
    ->relationService((new Service)
        ->relationsMembers((new ServiceMember)->orderBySeqAsc()->limitPerParent(2)
            ->relationUser((new User)
                ->relationsBattles((new Battle)->selectNone()->orderBySeqAsc()->limitPerParent(1)))))
    ->bind($db)->get()->toArray());
$run('relation_one_ordered', fn() => (new Battle)->selectNone()->seq(7)->relationService((new Service)->orderBySeqDesc())->bind($db)->get()->toArray());
$run('relation_if_parent', function () use ($db) {
    $items = [];
    foreach ((new Battle)->selectNone()->seqIn([7, 8, 14])->orderBySeqAsc()->relationUser((new User)->ifParentIsCloseEq(true))->bind($db)->gets() as $b) {
        $items[] = $b->toArray();
    }
    return $items;
});
$run('relation_empty_parents', fn() => $keys((new Battle)->seq(0)->relationUser(new User)->bind($db)->gets()));
$run('relation_off_join', fn() => (new Battle)->selectNone()->seq(8)->joinService((new Service)->relationsModules(new ServiceModule))->bind($db)->get()->toArray());
$run('paginate_relations', function () use ($db) {
    $p = (new Battle)->selectNone()->serviceSeq(7)->orderBySeqAsc()->relationUser(new User)->bind($db)->paginate(1, 3);
    $items = [];
    foreach ($p->items as $b) {
        $items[] = $b->toArray();
    }
    return ['total' => $p->total, 'items' => $items];
});
$run('key_by_column', fn() => (new Service)->seq(7)->relationsMembers((new ServiceMember)->orderBySeqAsc()->limitPerParent(3)->keyByUserSeq())->bind($db)->get()->toArray());
$run('key_by_unselected', fn() => (new Service)->seq(7)->relationsModules((new ServiceModule)->selectNone()->keyByName())->bind($db)->get()->toArray());
$run('types_roundtrip', function () use ($db, $remask) {
    $dt = '2026-06-01 12:34:56.123456';
    $created = $db->transaction(fn(Tx $tx) => (new Battle)
        ->setName('conf-types')
        ->setUserSeq(1)->setServiceSeq(999)->setServiceModuleSeq(1)->setServiceMemberSeq(1)
        ->setStartDt($dt)->setEndDt($dt)->setDisplayStartDt($dt)->setIsDisplay(true)->setTargetTeamPlayerCount(2147483647)->setReadCount(4294967295)->setPrice(12345.678)
        ->setJsonSetting(['k' => []])->setJsonsTags([])->setSerializeData('')
        ->bind($tx)->insert());
    $remask([$created->getSeq()], $created->getUpdatedTs());
    $b = (new Battle)->selectJsonSetting()->selectJsonsTags()->selectSerializeData()->seq($created->getSeq())->bind($db)->get();
    $b->delete();
    return [
        'display_start_dt' => fmtTime($b->getDisplayStartDt()), 'is_display' => $b->getIsDisplay(), 'is_close' => $b->getIsClose(),
        'target_team_player_count' => $b->getTargetTeamPlayerCount(), 'read_count' => $b->getReadCount(), 'price' => $b->getPrice(),
        'json_setting' => $b->getJsonSetting(), 'jsons_tags' => $b->getJsonsTags(), 'serialize_data' => $b->getSerializeData(),
    ];
});
$run('key_by_fn_to_array', function () use ($db) {
    $c = (new ServiceMember)->serviceSeq(7)->orderBySeqAsc()->limit(0, 2)
        ->relationUser((new User)->flatten())
        ->keyByFn(fn(ServiceMemberRow $m) => 'u' . $m->getUserSeq())
        ->bind($db)->gets();
    $items = [];
    foreach ($c as $k => $m) {
        $items[] = [(string) $k, $m->toArray()];
    }
    return $items;
});
$run('drop_child_key_to_array', fn() => (new User)->seq(5)->relationsBattles((new Battle)->selectNone()->orderBySeqAsc()->limitPerParent(2)->dropChildKey())->bind($db)->get()->toArray());
$fks = fn(Battle $q): Battle => $q
    ->setUserSeq(1)->setServiceSeq(999)->setServiceModuleSeq(1)->setServiceMemberSeq(1)
    ->setStartDt('2026-06-01 00:00:00')->setEndDt('2026-12-31 00:00:00');
$run('upsert', function () use ($db, $fks, $remask) {
    $a = null;
    $b = $db->transaction(function (Tx $tx) use ($fks, &$a) {
        $a = $fks((new Battle)->setUuid('conf-upsert')->setName('u1')->setReadCount(1))->bind($tx)->insert();
        $b = $fks((new Battle)->setUuid('conf-upsert')->setName('u2')->setReadCount(1))
            ->onDuplicateSetName('u2')->onDuplicatePlusReadCount(5)
            ->bind($tx)->insert();
        $b->delete();
        return $b;
    });
    $remask([$a->getSeq()], $b->getUpdatedTs());
    return ['same_seq' => $a->getSeq() === $b->getSeq(), 'name' => $b->getName(), 'read_count' => $b->getReadCount()];
});
$run('upsert_set_all', function () use ($db, $fks, $remask) {
    $a = null;
    $b = $db->transaction(function (Tx $tx) use ($fks, &$a) {
        $a = $fks((new Battle)->setUuid('conf-upsert')->setName('u1')->setReadCount(1))->bind($tx)->insert();
        $b = $fks((new Battle)->setUuid('conf-upsert')->setName('u3')->setReadCount(9))->onDuplicateSetAll()->bind($tx)->insert();
        $b->delete();
        return $b;
    });
    $remask([$a->getSeq()], $b->getUpdatedTs());
    return ['same_seq' => $a->getSeq() === $b->getSeq(), 'name' => $b->getName(), 'read_count' => $b->getReadCount()];
});
$run('save_branch', function () use ($db, $fks, $remask) {
    $r = $db->transaction(fn(Tx $tx) => $fks((new Battle)->setName('conf-save'))->bind($tx)->save());
    $remask([$r->getSeq()], $r->getUpdatedTs());
    // save() re-reads the row after its UPDATE; that SELECT is the read-back.
    $after = (new Battle)->setSeq($r->getSeq())->setName('conf-save-2')->bind($db)->save();
    $after->delete();
    return ['inserted' => $r->getSeq() > 0, 'after' => $after->getName()];
});
$run('bulk_update_plus_minus', function () use ($db, $fks, $remask) {
    $r = $db->transaction(fn(Tx $tx) => $fks((new Battle)->setReadCount(3)->setName('conf-bulk'))->bind($tx)->insert());
    $remask([$r->getSeq()], $r->getUpdatedTs());
    $seq = $r->getSeq();
    $read = fn(): int => (new Battle)->bind($db)->oneBySeq($seq)->getReadCount();
    (new Battle)->seq($seq)->plusReadCount(2)->bind($db)->update();
    $afterPlus = $read();
    (new Battle)->seq($seq)->minusReadCount(10)->bind($db)->update();
    $afterMinus = $read();
    (new Battle)->seq($seq)->setReadCountExpr('`read_count` * ? + 1', [2])->bind($db)->update();
    $afterExpr = $read();
    $deleted = (new Battle)->seq($seq)->bind($db)->delete();
    return ['after_plus' => $afterPlus, 'after_minus' => $afterMinus, 'after_expr' => $afterExpr, 'deleted' => $deleted];
});
$run('delete_cascade_order', function () use ($db, $remask) {
    [$s, $mod, $seqs] = $db->transaction(function (Tx $tx) {
        $s = (new Service)->setName('conf-svc')->bind($tx)->insert();
        $m1 = (new ServiceMember)->setServiceSeq($s->getSeq())->setUserSeq(1)->bind($tx)->insert();
        $m2 = (new ServiceMember)->setServiceSeq($s->getSeq())->setUserSeq(2)->bind($tx)->insert();
        $mod = (new ServiceModule)->setServiceSeq($s->getSeq())->setName('conf-mod')->bind($tx)->insert();
        return [$s, $mod, [$s->getSeq(), $m1->getSeq(), $m2->getSeq(), $mod->getSeq()]];
    });
    $remask($seqs, '');
    (new Service)->seq($s->getSeq())
        ->relationsMembers((new ServiceMember)->orderBySeqAsc())
        ->relationsModules((new ServiceModule)->noCascadeDelete())
        ->bind($db)->get()
        ->bind($db)->deleteCascade();
    $left = [
        'members_left' => (new ServiceMember)->serviceSeq($s->getSeq())->bind($db)->getCount(),
        'modules_left' => (new ServiceModule)->serviceSeq($s->getSeq())->bind($db)->getCount(),
        'service_left' => (new Service)->seq($s->getSeq())->bind($db)->getCount(),
    ];
    (new ServiceModule)->seq($mod->getSeq())->bind($db)->delete();
    return $left;
});
$run('sql_dump', fn() => (new Battle)->serviceSeq(7)->selectAesHexEmail()->limit(0, 1)->bind($db)->sql());
$run('agg_min_max', fn() => [
    'min' => (new Battle)->serviceSeq(7)->bind($db)->minSeq(),
    'max' => (new Battle)->serviceSeq(7)->bind($db)->maxSeq(),
    'distinct_users' => (new Battle)->serviceSeq(7)->bind($db)->countDistinctUserSeq(),
]);
$run('group_count_having', fn() => (new Battle)->serviceSeq(7)->groupByUserSeq()->having(fn(BattleWhere $w) => $w->expr('COUNT(*) > ?', [1]))->bind($db)->getCount());
$run('predicate_named', fn() => [
    'visible' => (new Battle)->visible()->serviceSeq(7)->bind($db)->getCount(),
    'started_after' => (new Battle)->startedAfter('2026-01-01 00:00:00')->serviceSeq(7)->bind($db)->getCount(),
]);
$run('raw_root', fn() => (new Battle)->raw('SELECT COUNT(*) AS n, MAX(seq) AS m FROM {table} WHERE service_seq = ? AND is_close = ?', [7, false])->bind($db)->rawAll());
$run('join_fulltext_or', fn() => (new Battle)
    ->joinService((new Service)->where(fn(ServiceWhere $w) => $w->seq(7)))
    ->isClose(false)
    ->and(fn(BattleWhere $w) => $w
        ->nameWithDescriptionMatchBoolean('battle')
        ->or()
        ->service(fn(ServiceWhere $s) => $s->name('service-999')))
    ->bind($db)->getCount());
$run('join_two_groups', fn() => (new Battle)
    ->joinService((new Service)->on(fn(ServiceWhere $w) => $w->name('service-7'))->where(fn(ServiceWhere $w) => $w->seqGt(0)))
    ->leftJoinUser((new User)->where(fn(UserWhere $w) => $w->nameContains('user-4')))
    ->seqIn([6, 106, 206, 406])
    ->bind($db)->getCount());
$run('join_multi_level', fn() => (new Battle)->selectNone()->seq(6)
    ->joinServiceMember((new ServiceMember)->selectNone()
        ->joinUser((new User)->selectNone())
        ->joinService((new Service)->selectNone()))
    ->bind($db)->get()->toArray());
$run('codec_roundtrip', function () use ($db, $remask) {
    $value = ['a' => 1, 'b' => [1, 2, ['c' => '한글/slash']], 'd' => null, 'e' => true, 'f' => 1.5];
    $created = $db->transaction(fn(Tx $tx) => (new Battle)
        ->setName('conf-codec')
        ->setUserSeq(1)->setServiceSeq(999)->setServiceModuleSeq(1)->setServiceMemberSeq(1)
        ->setStartDt('2026-06-01 00:00:00')->setEndDt('2026-12-31 00:00:00')
        ->setJsonSetting($value)->setJsonsTags(['x', 'y'])->setBase64Extra($value)->setSerializeData($value)->setGzExtend($value)->setIp('10.1.2.3')
        ->bind($tx)->insert());
    $remask([$created->getSeq()], $created->getUpdatedTs());
    $b = (new Battle)->selectJsonSetting()->selectJsonsTags()->selectBase64Extra()->selectSerializeData()->selectGzExtend()->seq($created->getSeq())->bind($db)->get();
    $b->delete();
    return ['json_setting' => $b->getJsonSetting(), 'jsons_tags' => $b->getJsonsTags(), 'base64_extra' => $b->getBase64Extra(), 'serialize_data' => $b->getSerializeData(), 'gz_extend' => $b->getGzExtend(), 'ip' => $b->getIp()];
});

// packed ip binds (SQLite) are raw bytes: substituted rather than fatal, as Go's encoder does
echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR), "\n";
