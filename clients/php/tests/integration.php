<?php
// PHP half of the S1 demo: same statements as clients/go/gen/gen_integration_test.go.
// Usage: php clients/php/tests/integration.php /abs/ormd.sock /abs/schema.json
// ORM_TEST_DRIVER (mysql | postgres | sqlite) and ORM_TEST_DSN select the database; ormd must run with the
// matching -dialect. MySQL-only checks (secret slots, the driver's error numbers) are keyed by driver; the
// deadlock interleaving is skipped on SQLite (one writer: two transactions cannot interleave row locks).
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use App\Orm\Battle;
use App\Orm\BattleWhere;
use App\Orm\CompositeAccount;
use App\Orm\CompositeMembership;
use App\Orm\Service;
use App\Orm\ServiceMember;
use App\Orm\ServiceModule;
use App\Orm\ServiceWhere;
use App\Orm\User;
use App\Orm\UserWhere;
use Orm\Code;
use Orm\Codec;
use Orm\Config;
use Orm\Db;
use Orm\AesKeyring;
use Orm\Orm;
use Orm\OrmException;
use Orm\Q;
use Orm\Registry;
use Orm\StreamResult;
use Orm\Tx;

$sock = $argv[1] ?? die("usage: integration.php /abs/ormd.sock /abs/schema.json\n");
$schema = $argv[2] ?? die("schema.json required\n");
$driver = orm_test_driver();
$log = [];
$hooked = [];
Orm::init(new Config(socket: $sock, schemaPath: $schema, aesKey: 'bench-salt', driver: $driver,
    onQuery: function (string $sql, array $binds, float $sec, string $planId, ?\Throwable $e) use (&$log, &$hooked) { $log[] = orm_norm_sql($sql); $hooked[] = [$binds, $planId, $e]; }));
$db = orm_open_db($driver, orm_test_dsn());
check($db->driver() === $driver, 'Db::driver()');
/** the binds sql() and the hook show for the aes select: the key twice on MySQL (AES in SQL), nothing else elsewhere (host AES) */
$aesBinds = [7];

$fail = 0;
function check(bool $ok, string $what): void { global $fail; if (!$ok) { $fail++; fwrite(STDERR, "FAIL: $what\n"); } }

// ---- reads ----
$b = Battle::query()->using($db)->getBySeq(42);
check($b !== null && $b->getSeq() === 42 && $b->getName() === 'battle-42' && $b->getAesHexEmail() === 'user42@example.com', 'one by pk + aes decode');
check($b->getDescription() === null && $b['name'] === 'battle-42', 'lazy column null by default; ArrayAccess');
check($b->getIsClose() === true && $b->getIsDisplay() === false, 'bool coercion (42: closed, not displayed)');
check($b->getMemo('dflt') === 'dflt', 'getX(default) for unknown column');

$b2 = Battle::query()->selectDescription()->seq(42)->using($db)->get();
check(str_starts_with((string) $b2->getDescription(), 'desc-42'), 'select lazy column');

$now = '2026-09-11 00:00:00';
$rows = Battle::query()
    ->serviceSeq(7)
    ->isClose(false)
    ->and(fn(BattleWhere $w) => $w
        ->isDisplay(true)
        ->or()
        ->and(fn(BattleWhere $w) => $w->isDisplay(false)->displayStartDtLt($now)))
    ->seqIn([6, 106, 206, 306, 406])
    ->orderBySeqDesc()
    ->limit(0, 3)
    ->using($db)->gets();
check(count($rows) === 3 && $rows->first()->getSeq() === 306, 'all + group + or + in + order + limit');
foreach ($rows as $seq => $r) { check($seq === $r->getSeq(), 'collection keyed by pk'); }

check(Battle::query()->serviceSeq(7)->using($db)->getCount() === 1000, 'count');
check(Battle::query()->serviceSeq(7)->using($db)->sumLikeCount() > 0, 'sum');

$cnt = Battle::query()
    ->join(Service::query()->where(fn(ServiceWhere $w) => $w->name('service-7')))
    ->leftJoin(User::query()->on(fn(UserWhere $w) => $w->nameContains('user')))
    ->isClose(false)
    ->and(fn(BattleWhere $w) => $w->isDisplay(true)->or()->service(fn(ServiceWhere $s) => $s->seqGt(1000)))
    ->using($db)->getCount();
check($cnt > 0, 'join + on/where + nav');

$page = Battle::query()->serviceSeq(7)->orderBySeqAsc()->using($db)->paginate(2, 10);
check($page->total === 1000 && $page->pages === 100 && count($page->items) === 10 && $page->items->first()->getSeq() === 1006, 'paginate');
check(Battle::query()->nameContains('%')->using($db)->getCount() === 0, 'contains escapes %');

// join result access
$j = Battle::query()->join(Service::query()->where(fn(ServiceWhere $w) => $w->seq(7)))->seq(6)->using($db)->get();
check($j !== null && $j->getService() !== null && $j->getService()->getName() === 'service-7' && $j['service']['name'] === 'service-7', 'joined row access');

$streamed = [];
$streamResult = Battle::query()->serviceSeq(7)->orderBySeqAsc()->using($db)->stream(function ($row) use (&$streamed): bool {
    $streamed[] = $row;
    return count($streamed) < 3;
});
check($streamResult->state === StreamResult::STOPPED && $streamResult->count === 3, 'stream visitor stop');
check(count($streamed) === 3 && $streamed[0] !== $streamed[1] && $streamed[0]->getSeq() !== $streamed[1]->getSeq(), 'stream row ownership');
check(Battle::query()->serviceSeq(7)->using($db)->getCount() > 0, 'stream cursor closes after visitor stop');
$streamResult = Battle::query()->serviceSeq(7)->orderBySeqAsc()->limit(0, 4)->using($db)->stream(fn($row): bool => true);
check($streamResult->state === StreamResult::EXHAUSTED && $streamResult->count === 4, 'stream exhaustion');
try {
    Battle::query()->relation(User::query())->using($db)->stream(fn($row): bool => true);
    check(false, 'relation stream must fail');
} catch (OrmException $e) {
    check($e->code_ === Code::IR_INVALID, 'relation stream error code');
}
try {
    Battle::query()->limit(0, 2)->using($db)->stream(static function ($row): bool { throw new \RuntimeException('stream visitor error'); });
    check(false, 'stream visitor error must propagate');
} catch (\RuntimeException $e) {
    check($e->getMessage() === 'stream visitor error' && Battle::query()->serviceSeq(7)->using($db)->getCount() > 0, 'stream cursor closes after visitor error');
}

// ---- relations ----
$n0 = count($log);
$rows = Battle::query()
    ->serviceSeq(7)->orderBySeqAsc()->limit(0, 5)
    ->relation(User::query())
    ->relation(Service::query()
        ->relations(ServiceMember::query()->orderBySeqDesc()->limitPerParent(3)->keyByUserSeq()->dropChildKey()))
    ->using($db)->gets();
check(count($rows) === 5 && count($log) - $n0 === 4, 'relation statements: main, user, service, members');
foreach ($rows as $b) {
    check($b->getUser() !== null && $b->getUser()->getSeq() === $b->getUserSeq() && $b['user']['name'] === 'user-' . $b->getUserSeq(), 'one relation');
    check($b->getService()->getSeq() === 7 && count($b->getService()->getMembers()) === 3, 'nested many relation, 3 per parent');
    foreach ($b->getService()->getMembers() as $k => $m) {
        check($k === $m->getUserSeq() && $m->getServiceSeq() === 7 && !array_key_exists('service_seq', $m->toArray()), 'key_by + drop_child_key');
    }
}
$rows = Battle::query()
    ->seqIn([7, 8, 14])->orderBySeqAsc()
    ->relation(User::query()->ifParentIsCloseEq(true)->relations(Battle::query()->orderBySeqAsc()->limitPerParent(2)))
    ->join(Service::query()->relations(ServiceModule::query()))
    ->using($db)->gets();
check($rows[7]->getUser() !== null && $rows[14]->getUser() !== null && $rows[8]->getUser() === null, 'if_parent loads only closed battles\' users');
check(count($rows[7]->getUser()->getBattles()) === 2, 'nested many under one, limit_per_parent');
check(count($rows[8]->getService()->getModules()) === 1 && $rows[8]->getService()->getModules()->first()->getServiceSeq() === $rows[8]->getServiceSeq(), 'relation off a join');
$n0 = count($log);
check(count(Battle::query()->seq(0)->relation(User::query())->using($db)->gets()) === 0 && count($log) - $n0 === 1, 'no parents → relation step skipped');
$one = Battle::query()->seq(42)->relation(Service::query()->relations(ServiceMember::query()->limitPerParent(1)))->using($db)->get();
check($one !== null && count($one->getService()->getMembers()) === 1, 'one + relation');
$m = ServiceMember::query()->serviceSeq(7)->orderBySeqAsc()->limit(0, 2)->relation(User::query()->flatten())->using($db)->gets()->first();
check($m['name'] === 'user-' . $m->getUserSeq() && $m->getName() === 'user-' . $m->getUserSeq() && $m->toArray()['name'] === $m['name'], 'flatten merges child columns into the parent');
$page = Battle::query()->serviceSeq(7)->orderBySeqAsc()->relation(User::query())->using($db)->paginate(1, 4);
check($page->total === 1000 && count($page->items) === 4 && $page->items->first()->getUser() !== null, 'paginate keeps relations');

// ---- writes ----
$created = $db->transaction(function (Tx $tx) {
    return Battle::query()
        ->setName('php-write')
        ->setUserSeq(1)->setServiceSeq(999)->setServiceModuleSeq(1)->setServiceMemberSeq(1)
        ->setStartDt('2026-06-01 00:00:00')->setEndDt('2026-12-31 00:00:00')
        ->setAesHexEmail('w@example.com')
        ->using($tx)->insert();
});
check($created !== null && $created->getSeq() > 0 && $created->getAesHexEmail() === 'w@example.com', 'insert in tx + aes');

$created->setName('php-write-2')->setLikeCount(5)->using($db)->updateOptimistic();
$again = Battle::query()->using($db)->getBySeq($created->getSeq());
check($again->getName() === 'php-write-2' && $again->getLikeCount() === 5, 'dirty update');
try {
    $created->setName('stale')->using($db)->updateOptimistic();
    check(false, 'optimistic lock should fail');
} catch (OrmException $e) {
    check($e->code_ === Code::OPTIMISTIC_LOCK, 'optimistic lock code');
}
$again->using($db)->delete();
check(Battle::query()->seq($created->getSeq())->using($db)->getCount() === 0, 'delete');

// ---- S3: upsert, save, query update/delete, deleteCascade, sql ----
$draft = fn(string $name, int $readCount = 1) => Battle::query()
    ->setName($name)->setReadCount($readCount)
    ->setUserSeq(1)->setServiceSeq(999)->setServiceModuleSeq(1)->setServiceMemberSeq(1)
    ->setStartDt('2026-06-01 00:00:00')->setEndDt('2026-12-31 00:00:00');
$a = $draft('php-u1')->setUuid('php-upsert')->using($db)->insert();
$b = $draft('php-u2')->setUuid('php-upsert')->onDuplicateSetName('php-u2')->onDuplicatePlusReadCount(5)->using($db)->insert();
check($a !== null && $b !== null && $b->getSeq() === $a->getSeq() && $b->getName() === 'php-u2' && $b->getReadCount() === 6, 'insert on duplicate updates and returns the existing row');
$c = $draft('php-u3', 9)->setUuid('php-upsert')->onDuplicateSetAll()->using($db)->insert();
check($c->getSeq() === $a->getSeq() && $c->getName() === 'php-u3' && $c->getReadCount() === 9, 'onDuplicateSetAll mirrors the draft');
// With PDO, PostgreSQL parameters carry no type: a bare ? inside CONCAT (variadic "any") is indeterminate there, `||` is not.
$concat = $driver === 'mysql' ? 'CONCAT(`name`, ?)' : '`name` || ?';
$d = $draft('php-u4')->setUuid('php-upsert')->onDuplicateSetNameExpr($concat, ['!'])->onDuplicateMinusReadCount(100)->using($db)->insert();
check($d->getSeq() === $a->getSeq() && $d->getName() === 'php-u3!' && $d->getReadCount() === 0, 'on duplicate expr + minus clamped at 0');
check(Battle::query()->seq($a->getSeq())->using($db)->delete() === 1 && Battle::query()->seq($a->getSeq())->using($db)->getCount() === 0, 'query delete returns the affected count');

$r = $draft('php-save')->using($db)->save();
check($r !== null && $r->getSeq() > 0 && $r->getName() === 'php-save', 'save without pk inserts');
$r2 = Battle::query()->setSeq($r->getSeq())->setName('php-save-2')->using($db)->save();
check($r2 !== null && $r2->getSeq() === $r->getSeq() && $r2->getName() === 'php-save-2' && $r2->getUserSeq() === 1, 'save with pk updates the other columns only');
check(Battle::query()->seq($r->getSeq())->plusReadCount(2)->setLikeCount(7)->using($db)->update() === 1, 'query update returns the affected count');
$r3 = Battle::query()->using($db)->getBySeq($r->getSeq());
check($r3->getReadCount() === 3 && $r3->getLikeCount() === 7, 'query update applied (read_count 1 + 2)');
try {
    Battle::query()->setName('x')->using($db)->update();
    check(false, 'update without where should throw');
} catch (OrmException $e) {
    check($e->code_ === Code::IR_INVALID, 'update without where → IR_INVALID');
}
check(Battle::query()->seq($r->getSeq())->using($db)->delete() === 1, 'query delete');

$n0 = count($log);
$dump = Battle::query()->serviceSeq(7)->selectAesHexEmail()->limit(0, 1)->using($db)->sql();
check(str_starts_with($dump['sql'], 'SELECT ') && $dump['binds'] === $aesBinds && count($log) === $n0, 'sql() dumps the main statement without executing');

$svc = $db->transaction(function (Tx $tx) {
    $s = Service::query()->setName('php-cascade')->using($tx)->insert();
    foreach ([1, 2] as $u) {
        ServiceMember::query()->setServiceSeq($s->getSeq())->setUserSeq($u)->using($tx)->insert();
    }
    ServiceModule::query()->setServiceSeq($s->getSeq())->setName('php-cascade-mod')->using($tx)->insert();
    return $s;
});
$loaded = Service::query()->seq($svc->getSeq())
    ->relations(ServiceMember::query()->orderBySeqAsc()->relation(User::query()))
    ->relations(ServiceModule::query()->noCascadeDelete())
    ->using($db)->get();
$n0 = count($log);
$loaded->using($db)->deleteCascade();
check(count($log) - $n0 === 3
    && str_starts_with($log[$n0], 'DELETE FROM `service_member`') && str_starts_with($log[$n0 + 1], 'DELETE FROM `service_member`') && str_starts_with($log[$n0 + 2], 'DELETE FROM `service`'),
    'deleteCascade: owned members first, then the service; noCascadeDelete stops at modules; users (parent direction) untouched');
check(ServiceMember::query()->serviceSeq($svc->getSeq())->using($db)->getCount() === 0 && Service::query()->seq($svc->getSeq())->using($db)->getCount() === 0
    && ServiceModule::query()->serviceSeq($svc->getSeq())->using($db)->getCount() === 1 && User::query()->seqIn([1, 2])->using($db)->getCount() === 2, 'deleteCascade result');
check(ServiceModule::query()->serviceSeq($svc->getSeq())->using($db)->delete() === 1, 'cascade cleanup');

// ---- deadlock gate: two processes, T1 updates A then B, T2 updates B then A ----
if ($driver !== 'sqlite') {
$rowA = $draft('dl-php-1')->using($db)->insert();
$rowB = $draft('dl-php-2')->using($db)->insert();
$procs = [];
foreach ([['t1', $rowA->getSeq(), $rowB->getSeq()], ['t2', $rowB->getSeq(), $rowA->getSeq()]] as [$tag, $first, $second]) {
    $cmd = [PHP_BINARY, '-d', 'apc.enable_cli=0', __DIR__ . '/deadlock_child.php', $sock, $schema, (string) $first, (string) $second, $tag];
    $p = proc_open($cmd, [['pipe', 'r'], ['pipe', 'w'], STDERR], $pipes);
    check($p !== false, "spawn $tag");
    $procs[$tag] = [$p, $pipes];
}
// Barrier: wait for both "locked" lines, then release both — only now does each ask for the other's row.
foreach ($procs as $tag => [$p, $pipes]) {
    check(trim((string) fgets($pipes[1])) === 'locked', "$tag locked its first row");
}
foreach ($procs as [$p, $pipes]) {
    fwrite($pipes[0], "go\n");
    fflush($pipes[0]);
}
$runs = [];
foreach ($procs as $tag => [$p, $pipes]) {
    $line = trim((string) fgets($pipes[1]));
    fclose($pipes[0]);
    fclose($pipes[1]);
    check(proc_close($p) === 0 && str_starts_with($line, 'done '), "$tag finished: $line");
    $runs[$tag] = (int) substr($line, 5);
}
check(array_sum($runs) >= 3, 'the deadlock loser re-ran its closure (' . json_encode($runs) . ')');
$last = $runs['t1'] > $runs['t2'] ? 't1' : 't2'; // the re-run side commits after the winner, so it wrote last
$a2 = Battle::query()->using($db)->getBySeq($rowA->getSeq());
$b2 = Battle::query()->using($db)->getBySeq($rowB->getSeq());
check($a2->getName() === "dl-php-$last" && $b2->getName() === "dl-php-$last", 'final values are the last writer\'s');
$rowA->using($db)->delete();
$rowB->using($db)->delete();
check(Battle::query()->seqIn([$rowA->getSeq(), $rowB->getSeq()])->using($db)->getCount() === 0, 'deadlock rows cleaned up');
} else {
    fwrite(STDERR, "skip: deadlock interleaving (SQLite has one writer; SQLITE_BUSY is mapped to DEADLOCK and re-run, but two transactions cannot interleave row locks)\n");
}

// ---- S4: countDistinct/min/max, having, named predicates, raw root ----
check(Battle::query()->serviceSeq(7)->using($db)->minSeq() === 6 && Battle::query()->serviceSeq(7)->using($db)->maxSeq() === 99906, 'min/max return the column type (int)');
check(Battle::query()->seq(0)->using($db)->minSeq() === null && Battle::query()->seq(0)->using($db)->maxStartDt() === null, 'min/max are null when no rows match');
check(preg_match('/^\d{4}-\d\d-\d\d /', (string) Battle::query()->serviceSeq(7)->using($db)->minStartDt()) === 1, 'min of a datetime column is its string form');
check(Battle::query()->seq(0)->using($db)->maxIp() === null && Battle::query()->seq(0)->using($db)->countDistinctIp() === 0, 'ip-styled column has the aggregate terminals (engine allows ip); null/0 when no rows');
$du = Battle::query()->serviceSeq(7)->using($db)->countDistinctUserSeq();
check($du > 0 && $du <= 1000 && Battle::query()->seq(0)->using($db)->countDistinctUserSeq() === 0, 'countDistinct is an int, 0 when no rows');
$groups = Battle::query()->serviceSeq(7)->groupByUserSeq()->using($db)->getCount();
check($groups === $du, 'count with groupBy is the number of groups');
$buckets = Battle::query()->serviceSeq(7)->groupByExpr('ROUND(`like_count`)', 'bucket')->using($db)->getsCount();
$bucket = $buckets->first();
check($bucket !== null && $bucket->getRowCount() > 0 && $bucket->bucket !== null, 'getsCount supports expression groups and row_count');
$multi = Battle::query()->serviceSeq(7)->groupByUserSeq()->having(fn(BattleWhere $w) => $w->expr('COUNT(*) > ?', [1]))->using($db)->getCount();
$single = Battle::query()->serviceSeq(7)->groupByUserSeq()->having(fn(BattleWhere $w) => $w->expr('COUNT(*) = ?', [1]))->using($db)->getCount();
check($multi + $single === $groups && $multi > 0, 'having filters the groups (' . $multi . ' multi + ' . $single . ' single)');
check(str_contains(Battle::query()->serviceSeq(7)->groupByUserSeq()->having(fn(BattleWhere $w) => $w->expr('COUNT(*) > ?', [1]))->using($db)->sql()['sql'], ' HAVING '), 'having is rendered');
try {
    Battle::query()->serviceSeq(7)->having(fn(BattleWhere $w) => $w->expr('COUNT(*) > ?', [1]))->using($db)->getCount();
    check(false, 'having without groupBy should throw');
} catch (OrmException $e) {
    check($e->code_ === Code::IR_INVALID, 'having without groupBy → IR_INVALID');
}
try {
    (new Q('battle'))->runScalar($db, 'min', 'aes_hex_email');
    check(false, 'min on a styled column should throw');
} catch (OrmException $e) {
    check($e->code_ === Code::OPERATOR_NOT_ALLOWED, 'min on a styled column → OPERATOR_NOT_ALLOWED (no method is generated for it)');
}

$vis = Battle::query()->visible()->serviceSeq(7)->using($db)->getCount();
check($vis > 0 && $vis === Battle::query()->serviceSeq(7)->isClose(false)->isDisplay(true)->using($db)->getCount(), 'visible() = is_close = 0 AND is_display = 1');
$since = '2026-01-01 00:00:00';
$sa = Battle::query()->startedAfter($since)->serviceSeq(7)->using($db)->getCount();
check($sa === Battle::query()->startDtGt($since)->serviceSeq(7)->using($db)->getCount(), 'startedAfter($v) binds its one argument');
$either = Battle::query()->serviceSeq(7)->and(fn(BattleWhere $w) => $w->visible()->or()->startedAfter($since))->using($db)->getCount();
check($either >= max($vis, $sa) && $either <= $vis + $sa, 'named predicates on the Where builder, with or()');
check(str_contains(orm_norm_sql(Battle::query()->visible()->using($db)->sql()['sql']), '(`a`.`is_close` = FALSE AND `a`.`is_display` = TRUE)'), 'predicate fragment reaches the SQL with its columns alias-resolved');

$raw = Battle::query()->raw('SELECT COUNT(*) AS n, MAX(seq) AS m FROM {table} WHERE service_seq = ? AND is_close = ?', [7, 0])->using($db)->rawAll();
check(count($raw) === 1 && array_keys($raw[0]) === ['n', 'm'] && $raw[0]['n'] === Battle::query()->serviceSeq(7)->isClose(false)->using($db)->getCount() && is_int($raw[0]['m']), 'rawAll: one row keyed by column name, ints as ints');
$raw2 = Battle::query()->raw('SELECT seq, name FROM {table} WHERE seq IN (?, ?) ORDER BY seq', [42, 6])->using($db)->rawAll();
check(count($raw2) === 2 && $raw2[0]['seq'] === 6 && $raw2[1]['name'] === 'battle-42', 'rawAll: rows in statement order, binds in order');
check(Battle::query()->raw('SELECT seq FROM {table} WHERE seq = ?', [0])->using($db)->rawAll() === [], 'rawAll: empty list when nothing matches');
try {
    Battle::query()->raw('SELECT seq FROM {table} WHERE seq = ?', [])->using($db)->rawAll();
    check(false, 'raw with a placeholder/bind mismatch should throw');
} catch (OrmException $e) {
    check($e->code_ === Code::IR_INVALID, 'raw placeholder/bind mismatch → IR_INVALID');
}

// ---- error surface ----
try {
    Battle::query()->seqIn([])->using($db)->getCount();
    check(false, 'EMPTY_IN should throw');
} catch (OrmException $e) {
    check($e->code_ === Code::EMPTY_IN, 'EMPTY_IN code');
}

// ---- S5: on_query hook payload ----
$n0 = count($hooked);
Battle::query()->serviceSeq(7)->selectAesHexEmail()->limit(0, 1)->using($db)->gets();
Battle::query()->serviceSeq(8)->selectAesHexEmail()->limit(0, 1)->using($db)->gets();
Battle::query()->serviceSeq(8)->selectAesHexEmail()->limit(0, 2)->using($db)->gets();
[$binds1, $plan1, $err1] = $hooked[$n0];
[, $plan2] = $hooked[$n0 + 1];
[, $plan3] = $hooked[$n0 + 2];
check($binds1 === $aesBinds && $err1 === null, 'hook binds carry no AES secret');
check(preg_match('/^[0-9a-f]{16}$/', $plan1) === 1 && $plan1 === $plan2 && $plan1 !== $plan3, 'plan_id is the 16-hex plan key: same shape → same id, different limit → different id');
try {
    Battle::query()->raw('SELECT no_such_column FROM {table}', [])->using($db)->rawAll();
    check(false, 'bad raw sql should throw');
} catch (\PDOException $e) {
    check(str_contains($e->getMessage(), 'no_such_column') && $hooked[count($hooked) - 1][2] === $e, 'unmapped driver errors pass through as PDOException and reach the hook');
}

// ---- S5: driver error mapping ----
$dup = $draft('php-dup')->setUuid('php-dup-uuid')->using($db)->insert();
try {
    $draft('php-dup-2')->setUuid('php-dup-uuid')->using($db)->insert();
    check(false, 'duplicate uuid should throw');
} catch (OrmException $e) {
    $driverMsg = ['mysql' => '1062', 'postgres' => '23505', 'sqlite' => 'UNIQUE'][$driver];
    check($e->code_ === Code::DUPLICATE_KEY && str_contains($e->getMessage(), $driverMsg) && $e->getPrevious() instanceof \PDOException, 'duplicate uuid → DUPLICATE_KEY with the driver message kept');
}
try {
    $db->transaction(fn(Tx $tx) => $draft('php-dup-3')->setUuid('php-dup-uuid')->using($tx)->insert());
    check(false, 'duplicate uuid in a transaction should throw');
} catch (OrmException $e) {
    check($e->code_ === Code::DUPLICATE_KEY && !$db->pdo->inTransaction(), 'DUPLICATE_KEY inside transaction() is not re-run and rolls back');
}
$dup->using($db)->delete();

// ---- S5: schema_hash boot check ----
Registry::generated('0000000000000000');
try {
    Orm::init(new Config(socket: $sock, schemaPath: $schema, aesKey: 'bench-salt', driver: $driver));
    check(false, 'wrong generated hash should throw');
} catch (OrmException $e) {
    check($e->code_ === Code::SCHEMA_HASH_MISMATCH, 'generated hash ≠ schema.json → SCHEMA_HASH_MISMATCH');
}
Registry::generated(json_decode(file_get_contents($schema), true)['schema_hash']);
try {
    Orm::init(new Config(socket: $sock, schemaPath: $schema, aesKey: 'bench-salt', driver: $driver === 'mysql' ? 'sqlite' : 'mysql'));
    check(false, 'a driver other than the ormd dialect should throw');
} catch (OrmException $e) {
    check(
        $e->code_ === Code::CONFIG
        && str_contains($e->getMessage(), 'compiles for')
        && str_contains($e->getMessage(), 'driver is'),
        'driver ≠ ormd dialect → CONFIG'
    );
}
Orm::init(new Config(socket: $sock, schemaPath: $schema, aesKey: 'bench-salt', driver: $driver));
try {
    orm_open_db($driver === 'sqlite' ? 'mysql' : 'sqlite', $driver === 'sqlite' ? orm_default_dsn('mysql') : '/nonexistent/orm.sqlite');
    check(false, 'a Db of another driver than the config should throw');
} catch (OrmException $e) {
    check($e->code_ === Code::CONFIG, 'Db driver ≠ configured driver → CONFIG (' . $e->getMessage() . ')');
}

// ---- S5: orm.toml ----
$toml = function (string $schemaLine, string $extra = '') use ($sock, $driver): string {
    $f = tempnam(sys_get_temp_dir(), 'orm-toml-');
    // MySQL names its user here; the PostgreSQL DSN carries user=; SQLite has none (db.dsn is the file)
    $cred = $driver === 'mysql' ? "user = \"root\"\npassword = \"\"\n" : '';
    file_put_contents($f, "$schemaLine\n[db]\ndriver = \"$driver\"\ndsn = \"" . orm_test_dsn() . "\"\n{$cred}pool = 8   # ignored by PHP\n[secrets]\naes = \"bench-salt\"\n[ormd]\nsocket = \"$sock\"\n[debug]\non_query = false\n$extra");
    return $f;
};
$bad = $toml('schema = "schema/schema.json"');
try {
    Orm::fromConfig($bad);
    check(false, 'relative schema path should throw');
} catch (OrmException $e) {
    check($e->code_ === Code::CONFIG && str_contains($e->getMessage(), 'absolute'), 'orm.toml relative path → CONFIG');
}
unlink($bad);
$link = sys_get_temp_dir() . '/orm-toml-link-' . getmypid() . '.json';
@unlink($link);
symlink($schema, $link);
$bad = $toml("schema = \"$link\"");
try {
    Orm::fromConfig($bad);
    check(false, 'symlinked schema path should throw');
} catch (OrmException $e) {
    check($e->code_ === Code::CONFIG && str_contains($e->getMessage(), 'symlink'), 'orm.toml symlink → CONFIG');
}
unlink($bad);
unlink($link);
$bad = $toml("schema = \"$schema\"", "[engine]\nwasm = [\"x\"]\n");
try {
    Orm::fromConfig($bad);
    check(false, 'array value should throw');
} catch (OrmException $e) {
    check($e->code_ === Code::CONFIG && str_contains($e->getMessage(), 'unsupported value'), 'orm.toml outside the subset → CONFIG');
}
unlink($bad);
$bad = $toml("schema = \"$schema\"", "[db]\n");
try {
    Orm::fromConfig($bad);
    check(false, 'a table declared twice should throw');
} catch (OrmException $e) {
    check($e->code_ === Code::CONFIG, 'orm.toml duplicate table → CONFIG');
}
unlink($bad);
$wrongDriver = str_replace("driver = \"$driver\"", 'driver = "' . ($driver === 'mysql' ? 'sqlite' : 'mysql') . '"', file_get_contents($bad = $toml("schema = \"$schema\"")));
file_put_contents($bad, $wrongDriver);
try {
    Orm::fromConfig($bad);
    check(false, 'db.driver other than the ormd dialect should throw');
} catch (OrmException $e) {
    check($e->code_ === Code::CONFIG, 'orm.toml db.driver ≠ ormd dialect → CONFIG (' . $e->getMessage() . ')');
}
unlink($bad);
$good = $toml("schema = \"$schema\"");
$db2 = Orm::fromConfig($good);
unlink($good);
check($db2 instanceof Db && $db2->driver() === $driver && Orm::config()->driver === $driver && Orm::config()->onQuery === null && Orm::config()->aesKey === 'bench-salt' && Battle::query()->using($db2)->getBySeq(42)->getAesHexEmail() === 'user42@example.com', 'fromConfig loads db (driver), secrets and ormd and passes the boot check');
$versioned = $toml("schema = \"$schema\"");
file_put_contents($versioned, str_replace("aes = \"bench-salt\"", "aes_version = 2\n[secrets.aes_keys]\n1 = \"old-key\"\n2 = \"bench-salt\"", file_get_contents($versioned)));
$db3 = Orm::fromConfig($versioned);
unlink($versioned);
check($db3 instanceof Db && Orm::config()->aesKey === 'bench-salt' && Orm::config()->aesVersion === 2, 'fromConfig loads [secrets.aes_keys] and aes_version');
Orm::init(new Config(socket: $sock, schemaPath: $schema, aesKey: 'bench-salt', driver: $driver,
    onQuery: function (string $sql, array $binds, float $sec, string $planId, ?\Throwable $e) use (&$log) { $log[] = $sql; }));

// ---- S6: host-side styles round trip on this database (aes/hex in SQL on MySQL, app-side elsewhere; ip packed on SQLite) ----
$hb = $draft('php-host')->setAesHexEmail('한글@example.com')->setAesHexPhone('')->setIp('2001:db8::1')->using($db)->insert();
check($hb->getAesHexEmail() === '한글@example.com' && $hb->getAesHexPhone() === '' && $hb->getIp() === '2001:db8::1', 'aes_hex and ip written by this executor read back equal (' . $driver . ')');
$rawHex = Battle::query()->raw('SELECT aes_hex_email AS h FROM {table} WHERE seq = ?', [$hb->getSeq()])->using($db)->rawAll()[0]['h'];
check($rawHex === Codec::hostEncode('한글@example.com', ['aes', 'hex'], 'bench-salt'), 'the stored aes_hex bytes are the host codec\'s, which tests/codec/aes-vectors.json proves are MySQL\'s');
check(count(Battle::query()->aesHexEmail('한글@example.com')->seq($hb->getSeq())->using($db)->gets()) === 1, 'aes_hex predicate binds the host-encoded value');
$hb->setIp('10.1.2.3')->using($db)->update();
check(Battle::query()->using($db)->getBySeq($hb->getSeq())->getIp() === '10.1.2.3', 'ip update (IPv4 packs to 4 bytes)');
$hb->using($db)->delete();

// ---- Composite primary and foreign keys ----
$tenantId = 910008;
CompositeMembership::query()->tenantIdEq($tenantId)->using($db)->delete();
CompositeAccount::query()->tenantIdEq($tenantId)->using($db)->delete();
foreach ([11, 12] as $accountId) {
    $account = CompositeAccount::query()->setTenantId($tenantId)->setAccountId($accountId)->setName("account-$accountId")->using($db)->insert();
    $member = CompositeMembership::query()->setTenantId($tenantId)->setAccountId($accountId)->setRole('reader')->using($db)->insert();
    check($account?->getTenantId() === $tenantId && $account->getAccountId() === $accountId && $member !== null, 'composite insert returns the complete identity');
}
$first = CompositeMembership::query()->using($db)->getByTenantIdAndAccountId($tenantId, 11);
check($first !== null, 'composite primary-key finder');
$first->setRole('owner')->using($db)->update();
$second = CompositeMembership::query()->setTenantId($tenantId)->setAccountId(12)->setRole('editor')->using($db)->save();
check($second?->getRole() === 'editor', 'composite save uses every key component');
$page = CompositeMembership::query()->tenantIdEq($tenantId)->orderByTenantIdAsc()->orderByAccountIdAsc()->using($db)->paginate(1, 1);
check($page->total === 2 && count($page->items) === 1 && $page->items->first()?->getAccountId() === 11, 'composite pagination preserves complete order');
$accounts = CompositeAccount::query()->tenantIdEq($tenantId)->orderByAccountIdAsc()->relations(CompositeMembership::query())->using($db)->gets();
check(count($accounts) === 2 && count($accounts->first()?->getMemberships()) === 1, 'composite relation uses every key component');
$compositeRollback = new \RuntimeException('composite rollback');
try {
    $db->transaction(function (Tx $tx) use ($tenantId, $compositeRollback): void {
        CompositeAccount::query()->setTenantId($tenantId)->setAccountId(13)->setName('rollback')->using($tx)->insert();
        CompositeMembership::query()->setTenantId($tenantId)->setAccountId(13)->setRole('rollback')->using($tx)->insert();
        throw $compositeRollback;
    });
} catch (\RuntimeException $error) {
    if ($error !== $compositeRollback) { throw $error; }
}
check(CompositeAccount::query()->tenantIdEq($tenantId)->accountIdEq(13)->using($db)->getCount() === 0, 'composite transaction rollback removes both rows');
$first->using($db)->delete();
check(CompositeMembership::query()->tenantIdEq($tenantId)->using($db)->getCount() === 1, 'composite row delete uses every key component');
CompositeMembership::query()->tenantIdEq($tenantId)->using($db)->delete();
CompositeAccount::query()->tenantIdEq($tenantId)->using($db)->delete();

// ---- S7: versioned AES database rotation ----
$rotationTable = 'orm_aes_rotation_test';
$quote = fn(string $name): string => $driver === 'mysql' ? "`$name`" : "\"$name\"";
$db->pdo->exec('DROP TABLE IF EXISTS ' . $quote($rotationTable));
$db->pdo->exec('CREATE TABLE ' . $quote($rotationTable) . ' (' . $quote('tenant_id') . ' BIGINT NOT NULL, ' . $quote('id') . ' BIGINT NOT NULL, ' . $quote('aes_key_version') . ' INTEGER NOT NULL, ' . $quote('aes_hex_email') . ' VARCHAR(255), ' . $quote('aes_hex_phone') . ' VARCHAR(255), PRIMARY KEY (' . $quote('tenant_id') . ', ' . $quote('id') . '))');
$seed = $db->pdo->prepare('INSERT INTO ' . $quote($rotationTable) . ' (' . $quote('tenant_id') . ', ' . $quote('id') . ', ' . $quote('aes_key_version') . ', ' . $quote('aes_hex_email') . ', ' . $quote('aes_hex_phone') . ') VALUES (?, ?, ?, ?, ?)');
$encrypted = [Codec::hostEncode('member@example.test', ['aes', 'hex'], 'rotation-key-v1'), Codec::hostEncode('01012345678', ['aes', 'hex'], 'rotation-key-v1')];
foreach ([1, 2] as $id) { $seed->execute([7, $id, 1, ...$encrypted]); }
$rotationSpec = ['table' => $rotationTable, 'primary_keys' => ['tenant_id', 'id'], 'version_column' => 'aes_key_version', 'columns' => [['name' => 'aes_hex_email', 'styles' => ['aes', 'hex']], ['name' => 'aes_hex_phone', 'styles' => ['aes', 'hex']]]];
$keyring = new AesKeyring([1 => 'rotation-key-v1', 2 => 'rotation-key-v2'], 2);
$before = $db->aesStatus($rotationSpec, $keyring);
$changed = $db->rotateAESRows($rotationSpec, $keyring);
$after = $db->aesStatus($rotationSpec, $keyring);
$repeated = $db->rotateAESRows($rotationSpec, $keyring);
$stored = $db->pdo->query('SELECT ' . $quote('aes_key_version') . ', ' . $quote('aes_hex_email') . ', ' . $quote('aes_hex_phone') . ' FROM ' . $quote($rotationTable) . ' WHERE ' . $quote('tenant_id') . ' = 7 AND ' . $quote('id') . ' = 1')->fetch(\PDO::FETCH_NUM);
check($before->total === 2 && $before->pending === 2 && $before->versions[1] === 2, 'AES status reports the stored source version');
check($changed === 2 && $after->pending === 0 && $after->versions[2] === 2 && $repeated === 0, 'AES rotation updates every composite-key row once and repeat is a no-op');
check((int) $stored[0] === 2 && Codec::hostDecode($stored[1], ['aes', 'hex'], 'rotation-key-v2') === 'member@example.test' && Codec::hostDecode($stored[2], ['aes', 'hex'], 'rotation-key-v2') === '01012345678', 'AES rotation stores every AES column with the current key');
$db->pdo->exec('DROP TABLE ' . $quote($rotationTable));

if ($fail === 0) {
    echo "ok — " . count($log) . " statements\n";
    exit(0);
}
foreach ($log as $s) { fwrite(STDERR, "  $s\n"); }
exit(1);
