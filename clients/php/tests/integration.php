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
use Orm\Orm;
use Orm\OrmException;
use Orm\Q;
use Orm\Registry;
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
$aesBinds = $driver === 'mysql' ? ['$SECRET', '$SECRET', 7] : [7];

$fail = 0;
function check(bool $ok, string $what): void { global $fail; if (!$ok) { $fail++; fwrite(STDERR, "FAIL: $what\n"); } }

// ---- reads ----
$b = (new Battle)->bind($db)->getBySeq(42);
check($b !== null && $b->getSeq() === 42 && $b->getName() === 'battle-42' && $b->getAesHexEmail() === 'user42@example.com', 'one by pk + aes decode');
check($b->getDescription() === null && $b['name'] === 'battle-42', 'lazy column null by default; ArrayAccess');
check($b->getIsClose() === true && $b->getIsDisplay() === false, 'bool coercion (42: closed, not displayed)');
check($b->getMemo('dflt') === 'dflt', 'getX(default) for unknown column');

$b2 = (new Battle)->selectDescription()->seq(42)->bind($db)->get();
check(str_starts_with((string) $b2->getDescription(), 'desc-42'), 'select lazy column');

$now = '2026-09-11 00:00:00';
$rows = (new Battle)
    ->serviceSeq(7)
    ->isClose(false)
    ->and(fn(BattleWhere $w) => $w
        ->isDisplay(true)
        ->or()
        ->and(fn(BattleWhere $w) => $w->isDisplay(false)->displayStartDtLt($now)))
    ->seqIn([6, 106, 206, 306, 406])
    ->orderBySeqDesc()
    ->limit(0, 3)
    ->bind($db)->gets();
check(count($rows) === 3 && $rows->first()->getSeq() === 306, 'all + group + or + in + order + limit');
foreach ($rows as $seq => $r) { check($seq === $r->getSeq(), 'collection keyed by pk'); }

check((new Battle)->serviceSeq(7)->bind($db)->getCount() === 1000, 'count');
check((new Battle)->serviceSeq(7)->bind($db)->sumLikeCount() > 0, 'sum');

$cnt = (new Battle)
    ->joinService((new Service)->where(fn(ServiceWhere $w) => $w->name('service-7')))
    ->leftJoinUser((new User)->on(fn(UserWhere $w) => $w->nameContains('user')))
    ->isClose(false)
    ->and(fn(BattleWhere $w) => $w->isDisplay(true)->or()->service(fn(ServiceWhere $s) => $s->seqGt(1000)))
    ->bind($db)->getCount();
check($cnt > 0, 'join + on/where + nav');

$page = (new Battle)->serviceSeq(7)->orderBySeqAsc()->bind($db)->paginate(2, 10);
check($page->total === 1000 && $page->pages === 100 && count($page->items) === 10 && $page->items->first()->getSeq() === 1006, 'paginate');
check((new Battle)->nameContains('%')->bind($db)->getCount() === 0, 'contains escapes %');

// join result access
$j = (new Battle)->joinService((new Service)->where(fn(ServiceWhere $w) => $w->seq(7)))->seq(6)->bind($db)->get();
check($j !== null && $j->getService() !== null && $j->getService()->getName() === 'service-7' && $j['service']['name'] === 'service-7', 'joined row access');

// ---- relations ----
$n0 = count($log);
$rows = (new Battle)
    ->serviceSeq(7)->orderBySeqAsc()->limit(0, 5)
    ->relationUser(new User)
    ->relationService((new Service)
        ->relationsMembers((new ServiceMember)->orderBySeqDesc()->limitPerParent(3)->keyByUserSeq()->dropChildKey()))
    ->bind($db)->gets();
check(count($rows) === 5 && count($log) - $n0 === 4, 'relation statements: main, user, service, members');
foreach ($rows as $b) {
    check($b->getUser() !== null && $b->getUser()->getSeq() === $b->getUserSeq() && $b['user']['name'] === 'user-' . $b->getUserSeq(), 'one relation');
    check($b->getService()->getSeq() === 7 && count($b->getService()->getMembers()) === 3, 'nested many relation, 3 per parent');
    foreach ($b->getService()->getMembers() as $k => $m) {
        check($k === $m->getUserSeq() && $m->getServiceSeq() === 7 && !array_key_exists('service_seq', $m->toArray()), 'key_by + drop_child_key');
    }
}
$rows = (new Battle)
    ->seqIn([7, 8, 14])->orderBySeqAsc()
    ->relationUser((new User)->ifParentIsCloseEq(true)->relationsBattles((new Battle)->orderBySeqAsc()->limitPerParent(2)))
    ->joinService((new Service)->relationsModules(new ServiceModule))
    ->bind($db)->gets();
check($rows[7]->getUser() !== null && $rows[14]->getUser() !== null && $rows[8]->getUser() === null, 'if_parent loads only closed battles\' users');
check(count($rows[7]->getUser()->getBattles()) === 2, 'nested many under one, limit_per_parent');
check(count($rows[8]->getService()->getModules()) === 1 && $rows[8]->getService()->getModules()->first()->getServiceSeq() === $rows[8]->getServiceSeq(), 'relation off a join');
$n0 = count($log);
check(count((new Battle)->seq(0)->relationUser(new User)->bind($db)->gets()) === 0 && count($log) - $n0 === 1, 'no parents → relation step skipped');
$one = (new Battle)->seq(42)->relationService((new Service)->relationsMembers((new ServiceMember)->limitPerParent(1)))->bind($db)->get();
check($one !== null && count($one->getService()->getMembers()) === 1, 'one + relation');
$m = (new ServiceMember)->serviceSeq(7)->orderBySeqAsc()->limit(0, 2)->relationUser((new User)->flatten())->bind($db)->gets()->first();
check($m['name'] === 'user-' . $m->getUserSeq() && $m->getName() === 'user-' . $m->getUserSeq() && $m->toArray()['name'] === $m['name'], 'flatten merges child columns into the parent');
$page = (new Battle)->serviceSeq(7)->orderBySeqAsc()->relationUser(new User)->bind($db)->paginate(1, 4);
check($page->total === 1000 && count($page->items) === 4 && $page->items->first()->getUser() !== null, 'paginate keeps relations');

// ---- writes ----
$created = $db->transaction(function (Tx $tx) {
    return (new Battle)
        ->setName('php-write')
        ->setUserSeq(1)->setServiceSeq(999)->setServiceModuleSeq(1)->setServiceMemberSeq(1)
        ->setStartDt('2026-06-01 00:00:00')->setEndDt('2026-12-31 00:00:00')
        ->setAesHexEmail('w@example.com')
        ->bind($tx)->insert();
});
check($created !== null && $created->getSeq() > 0 && $created->getAesHexEmail() === 'w@example.com', 'insert in tx + aes');

$created->setName('php-write-2')->setLikeCount(5)->bind($db)->updateOptimistic();
$again = (new Battle)->bind($db)->getBySeq($created->getSeq());
check($again->getName() === 'php-write-2' && $again->getLikeCount() === 5, 'dirty update');
try {
    $created->setName('stale')->bind($db)->updateOptimistic();
    check(false, 'optimistic lock should fail');
} catch (OrmException $e) {
    check($e->code_ === Code::OPTIMISTIC_LOCK, 'optimistic lock code');
}
$again->bind($db)->delete();
check((new Battle)->seq($created->getSeq())->bind($db)->getCount() === 0, 'delete');

// ---- S3: upsert, save, query update/delete, deleteCascade, sql ----
$draft = fn(string $name, int $readCount = 1) => (new Battle)
    ->setName($name)->setReadCount($readCount)
    ->setUserSeq(1)->setServiceSeq(999)->setServiceModuleSeq(1)->setServiceMemberSeq(1)
    ->setStartDt('2026-06-01 00:00:00')->setEndDt('2026-12-31 00:00:00');
$a = $draft('php-u1')->setUuid('php-upsert')->bind($db)->insert();
$b = $draft('php-u2')->setUuid('php-upsert')->onDuplicateSetName('php-u2')->onDuplicatePlusReadCount(5)->bind($db)->insert();
check($a !== null && $b !== null && $b->getSeq() === $a->getSeq() && $b->getName() === 'php-u2' && $b->getReadCount() === 6, 'insert on duplicate updates and returns the existing row');
$c = $draft('php-u3', 9)->setUuid('php-upsert')->onDuplicateSetAll()->bind($db)->insert();
check($c->getSeq() === $a->getSeq() && $c->getName() === 'php-u3' && $c->getReadCount() === 9, 'onDuplicateSetAll mirrors the draft');
// With PDO, PostgreSQL parameters carry no type: a bare ? inside CONCAT (variadic "any") is indeterminate there, `||` is not.
$concat = $driver === 'mysql' ? 'CONCAT(`name`, ?)' : '`name` || ?';
$d = $draft('php-u4')->setUuid('php-upsert')->onDuplicateSetNameExpr($concat, ['!'])->onDuplicateMinusReadCount(100)->bind($db)->insert();
check($d->getSeq() === $a->getSeq() && $d->getName() === 'php-u3!' && $d->getReadCount() === 0, 'on duplicate expr + minus clamped at 0');
check((new Battle)->seq($a->getSeq())->bind($db)->delete() === 1 && (new Battle)->seq($a->getSeq())->bind($db)->getCount() === 0, 'query delete returns the affected count');

$r = $draft('php-save')->bind($db)->save();
check($r !== null && $r->getSeq() > 0 && $r->getName() === 'php-save', 'save without pk inserts');
$r2 = (new Battle)->setSeq($r->getSeq())->setName('php-save-2')->bind($db)->save();
check($r2 !== null && $r2->getSeq() === $r->getSeq() && $r2->getName() === 'php-save-2' && $r2->getUserSeq() === 1, 'save with pk updates the other columns only');
check((new Battle)->seq($r->getSeq())->plusReadCount(2)->setLikeCount(7)->bind($db)->update() === 1, 'query update returns the affected count');
$r3 = (new Battle)->bind($db)->getBySeq($r->getSeq());
check($r3->getReadCount() === 3 && $r3->getLikeCount() === 7, 'query update applied (read_count 1 + 2)');
try {
    (new Battle)->setName('x')->bind($db)->update();
    check(false, 'update without where should throw');
} catch (OrmException $e) {
    check($e->code_ === Code::IR_INVALID, 'update without where → IR_INVALID');
}
check((new Battle)->seq($r->getSeq())->bind($db)->delete() === 1, 'query delete');

$n0 = count($log);
$dump = (new Battle)->serviceSeq(7)->selectAesHexEmail()->limit(0, 1)->bind($db)->sql();
check(str_starts_with($dump['sql'], 'SELECT ') && $dump['binds'] === $aesBinds && count($log) === $n0, 'sql() dumps the main statement without executing');

$svc = $db->transaction(function (Tx $tx) {
    $s = (new Service)->setName('php-cascade')->bind($tx)->insert();
    foreach ([1, 2] as $u) {
        (new ServiceMember)->setServiceSeq($s->getSeq())->setUserSeq($u)->bind($tx)->insert();
    }
    (new ServiceModule)->setServiceSeq($s->getSeq())->setName('php-cascade-mod')->bind($tx)->insert();
    return $s;
});
$loaded = (new Service)->seq($svc->getSeq())
    ->relationsMembers((new ServiceMember)->orderBySeqAsc()->relationUser(new User))
    ->relationsModules((new ServiceModule)->noCascadeDelete())
    ->bind($db)->get();
$n0 = count($log);
$loaded->bind($db)->deleteCascade();
check(count($log) - $n0 === 3
    && str_starts_with($log[$n0], 'DELETE FROM `service_member`') && str_starts_with($log[$n0 + 1], 'DELETE FROM `service_member`') && str_starts_with($log[$n0 + 2], 'DELETE FROM `service`'),
    'deleteCascade: owned members first, then the service; noCascadeDelete stops at modules; users (parent direction) untouched');
check((new ServiceMember)->serviceSeq($svc->getSeq())->bind($db)->getCount() === 0 && (new Service)->seq($svc->getSeq())->bind($db)->getCount() === 0
    && (new ServiceModule)->serviceSeq($svc->getSeq())->bind($db)->getCount() === 1 && (new User)->seqIn([1, 2])->bind($db)->getCount() === 2, 'deleteCascade result');
check((new ServiceModule)->serviceSeq($svc->getSeq())->bind($db)->delete() === 1, 'cascade cleanup');

// ---- deadlock gate: two processes, T1 updates A then B, T2 updates B then A ----
if ($driver !== 'sqlite') {
$rowA = $draft('dl-php-1')->bind($db)->insert();
$rowB = $draft('dl-php-2')->bind($db)->insert();
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
$a2 = (new Battle)->bind($db)->getBySeq($rowA->getSeq());
$b2 = (new Battle)->bind($db)->getBySeq($rowB->getSeq());
check($a2->getName() === "dl-php-$last" && $b2->getName() === "dl-php-$last", 'final values are the last writer\'s');
$rowA->bind($db)->delete();
$rowB->bind($db)->delete();
check((new Battle)->seqIn([$rowA->getSeq(), $rowB->getSeq()])->bind($db)->getCount() === 0, 'deadlock rows cleaned up');
} else {
    fwrite(STDERR, "skip: deadlock interleaving (SQLite has one writer; SQLITE_BUSY is mapped to DEADLOCK and re-run, but two transactions cannot interleave row locks)\n");
}

// ---- S4: countDistinct/min/max, having, named predicates, raw root ----
check((new Battle)->serviceSeq(7)->bind($db)->minSeq() === 6 && (new Battle)->serviceSeq(7)->bind($db)->maxSeq() === 99906, 'min/max return the column type (int)');
check((new Battle)->seq(0)->bind($db)->minSeq() === null && (new Battle)->seq(0)->bind($db)->maxStartDt() === null, 'min/max are null when no rows match');
check(preg_match('/^\d{4}-\d\d-\d\d /', (string) (new Battle)->serviceSeq(7)->bind($db)->minStartDt()) === 1, 'min of a datetime column is its string form');
check((new Battle)->seq(0)->bind($db)->maxIp() === null && (new Battle)->seq(0)->bind($db)->countDistinctIp() === 0, 'ip-styled column has the aggregate terminals (engine allows ip); null/0 when no rows');
$du = (new Battle)->serviceSeq(7)->bind($db)->countDistinctUserSeq();
check($du > 0 && $du <= 1000 && (new Battle)->seq(0)->bind($db)->countDistinctUserSeq() === 0, 'countDistinct is an int, 0 when no rows');
$groups = (new Battle)->serviceSeq(7)->groupByUserSeq()->bind($db)->getCount();
check($groups === $du, 'count with groupBy is the number of groups');
$buckets = (new Battle)->serviceSeq(7)->groupByExpr('ROUND(`like_count`)', 'bucket')->bind($db)->getsCount();
$bucket = $buckets->first();
check($bucket !== null && $bucket->getRowCount() > 0 && $bucket->bucket !== null, 'getsCount supports expression groups and row_count');
$multi = (new Battle)->serviceSeq(7)->groupByUserSeq()->having(fn(BattleWhere $w) => $w->expr('COUNT(*) > ?', [1]))->bind($db)->getCount();
$single = (new Battle)->serviceSeq(7)->groupByUserSeq()->having(fn(BattleWhere $w) => $w->expr('COUNT(*) = ?', [1]))->bind($db)->getCount();
check($multi + $single === $groups && $multi > 0, 'having filters the groups (' . $multi . ' multi + ' . $single . ' single)');
check(str_contains((new Battle)->serviceSeq(7)->groupByUserSeq()->having(fn(BattleWhere $w) => $w->expr('COUNT(*) > ?', [1]))->bind($db)->sql()['sql'], ' HAVING '), 'having is rendered');
try {
    (new Battle)->serviceSeq(7)->having(fn(BattleWhere $w) => $w->expr('COUNT(*) > ?', [1]))->bind($db)->getCount();
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

$vis = (new Battle)->visible()->serviceSeq(7)->bind($db)->getCount();
check($vis > 0 && $vis === (new Battle)->serviceSeq(7)->isClose(false)->isDisplay(true)->bind($db)->getCount(), 'visible() = is_close = 0 AND is_display = 1');
$since = '2026-01-01 00:00:00';
$sa = (new Battle)->startedAfter($since)->serviceSeq(7)->bind($db)->getCount();
check($sa === (new Battle)->startDtGt($since)->serviceSeq(7)->bind($db)->getCount(), 'startedAfter($v) binds its one argument');
$either = (new Battle)->serviceSeq(7)->and(fn(BattleWhere $w) => $w->visible()->or()->startedAfter($since))->bind($db)->getCount();
check($either >= max($vis, $sa) && $either <= $vis + $sa, 'named predicates on the Where builder, with or()');
check(str_contains(orm_norm_sql((new Battle)->visible()->bind($db)->sql()['sql']), '(`a`.`is_close` = FALSE AND `a`.`is_display` = TRUE)'), 'predicate fragment reaches the SQL with its columns alias-resolved');

$raw = (new Battle)->raw('SELECT COUNT(*) AS n, MAX(seq) AS m FROM {table} WHERE service_seq = ? AND is_close = ?', [7, 0])->bind($db)->rawAll();
check(count($raw) === 1 && array_keys($raw[0]) === ['n', 'm'] && $raw[0]['n'] === (new Battle)->serviceSeq(7)->isClose(false)->bind($db)->getCount() && is_int($raw[0]['m']), 'rawAll: one row keyed by column name, ints as ints');
$raw2 = (new Battle)->raw('SELECT seq, name FROM {table} WHERE seq IN (?, ?) ORDER BY seq', [42, 6])->bind($db)->rawAll();
check(count($raw2) === 2 && $raw2[0]['seq'] === 6 && $raw2[1]['name'] === 'battle-42', 'rawAll: rows in statement order, binds in order');
check((new Battle)->raw('SELECT seq FROM {table} WHERE seq = ?', [0])->bind($db)->rawAll() === [], 'rawAll: empty list when nothing matches');
try {
    (new Battle)->raw('SELECT seq FROM {table} WHERE seq = ?', [])->bind($db)->rawAll();
    check(false, 'raw with a placeholder/bind mismatch should throw');
} catch (OrmException $e) {
    check($e->code_ === Code::IR_INVALID, 'raw placeholder/bind mismatch → IR_INVALID');
}

// ---- error surface ----
try {
    (new Battle)->seqIn([])->bind($db)->getCount();
    check(false, 'EMPTY_IN should throw');
} catch (OrmException $e) {
    check($e->code_ === Code::EMPTY_IN, 'EMPTY_IN code');
}

// ---- S5: on_query hook payload ----
$n0 = count($hooked);
(new Battle)->serviceSeq(7)->selectAesHexEmail()->limit(0, 1)->bind($db)->gets();
(new Battle)->serviceSeq(8)->selectAesHexEmail()->limit(0, 1)->bind($db)->gets();
(new Battle)->serviceSeq(8)->selectAesHexEmail()->limit(0, 2)->bind($db)->gets();
[$binds1, $plan1, $err1] = $hooked[$n0];
[, $plan2] = $hooked[$n0 + 1];
[, $plan3] = $hooked[$n0 + 2];
check($binds1 === $aesBinds && $err1 === null, $driver === 'mysql' ? 'hook binds mask secret slots as $SECRET' : 'hook binds carry no secret (host AES)');
check(preg_match('/^[0-9a-f]{16}$/', $plan1) === 1 && $plan1 === $plan2 && $plan1 !== $plan3, 'plan_id is the 16-hex plan key: same shape → same id, different limit → different id');
try {
    (new Battle)->raw('SELECT no_such_column FROM {table}', [])->bind($db)->rawAll();
    check(false, 'bad raw sql should throw');
} catch (\PDOException $e) {
    check(str_contains($e->getMessage(), 'no_such_column') && $hooked[count($hooked) - 1][2] === $e, 'unmapped driver errors pass through as PDOException and reach the hook');
}

// ---- S5: driver error mapping ----
$dup = $draft('php-dup')->setUuid('php-dup-uuid')->bind($db)->insert();
try {
    $draft('php-dup-2')->setUuid('php-dup-uuid')->bind($db)->insert();
    check(false, 'duplicate uuid should throw');
} catch (OrmException $e) {
    $driverMsg = ['mysql' => '1062', 'postgres' => '23505', 'sqlite' => 'UNIQUE'][$driver];
    check($e->code_ === Code::DUPLICATE_KEY && str_contains($e->getMessage(), $driverMsg) && $e->getPrevious() instanceof \PDOException, 'duplicate uuid → DUPLICATE_KEY with the driver message kept');
}
try {
    $db->transaction(fn(Tx $tx) => $draft('php-dup-3')->setUuid('php-dup-uuid')->bind($tx)->insert());
    check(false, 'duplicate uuid in a transaction should throw');
} catch (OrmException $e) {
    check($e->code_ === Code::DUPLICATE_KEY && !$db->pdo->inTransaction(), 'DUPLICATE_KEY inside transaction() is not re-run and rolls back');
}
$dup->bind($db)->delete();

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
    check($e->code_ === Code::CONFIG && str_contains($e->getMessage(), '-dialect'), 'driver ≠ ormd dialect → CONFIG');
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
check($db2 instanceof Db && $db2->driver() === $driver && Orm::config()->driver === $driver && Orm::config()->onQuery === null && Orm::config()->aesKey === 'bench-salt' && (new Battle)->bind($db2)->getBySeq(42)->getAesHexEmail() === 'user42@example.com', 'fromConfig loads db (driver), secrets and ormd and passes the boot check');
Orm::init(new Config(socket: $sock, schemaPath: $schema, aesKey: 'bench-salt', driver: $driver,
    onQuery: function (string $sql, array $binds, float $sec, string $planId, ?\Throwable $e) use (&$log) { $log[] = $sql; }));

// ---- S6: host-side styles round trip on this database (aes/hex in SQL on MySQL, app-side elsewhere; ip packed on SQLite) ----
$hb = $draft('php-host')->setAesHexEmail('한글@example.com')->setAesHexPhone('')->setIp('2001:db8::1')->bind($db)->insert();
check($hb->getAesHexEmail() === '한글@example.com' && $hb->getAesHexPhone() === '' && $hb->getIp() === '2001:db8::1', 'aes_hex and ip written by this executor read back equal (' . $driver . ')');
$rawHex = (new Battle)->raw('SELECT aes_hex_email AS h FROM {table} WHERE seq = ?', [$hb->getSeq()])->bind($db)->rawAll()[0]['h'];
check($rawHex === Codec::hostEncode('한글@example.com', ['aes', 'hex'], 'bench-salt'), 'the stored aes_hex bytes are the host codec\'s, which tests/codec/aes-vectors.json proves are MySQL\'s');
check(count((new Battle)->aesHexEmail('한글@example.com')->seq($hb->getSeq())->bind($db)->gets()) === 1, 'aes_hex predicate binds the host-encoded value');
$hb->setIp('10.1.2.3')->bind($db)->update();
check((new Battle)->bind($db)->getBySeq($hb->getSeq())->getIp() === '10.1.2.3', 'ip update (IPv4 packs to 4 bytes)');
$hb->bind($db)->delete();

if ($fail === 0) {
    echo "ok — " . count($log) . " statements\n";
    exit(0);
}
foreach ($log as $s) { fwrite(STDERR, "  $s\n"); }
exit(1);
