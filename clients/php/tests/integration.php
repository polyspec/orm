<?php
// PHP half of the S1 demo: same statements as clients/go/gen/gen_integration_test.go.
// Usage: php clients/php/tests/integration.php /abs/ormd.sock /abs/schema.json
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
use Orm\Config;
use Orm\Db;
use Orm\Orm;
use Orm\OrmException;
use Orm\Q;
use Orm\Tx;

$sock = $argv[1] ?? die("usage: integration.php /abs/ormd.sock /abs/schema.json\n");
$schema = $argv[2] ?? die("schema.json required\n");
$log = [];
Orm::init(new Config(socket: $sock, schemaPath: $schema, aesKey: 'bench-salt',
    onQuery: function (string $sql, array $args, float $sec, ?\Throwable $e) use (&$log) { $log[] = $sql; }));
$db = Db::mysql('mysql:unix_socket=/tmp/mysql.sock;dbname=orm_bench;charset=utf8mb4', 'root', '');

$fail = 0;
function check(bool $ok, string $what): void { global $fail; if (!$ok) { $fail++; fwrite(STDERR, "FAIL: $what\n"); } }

// ---- reads ----
$b = (new Battle)->oneBySeq($db, 42);
check($b !== null && $b->getSeq() === 42 && $b->getName() === 'battle-42' && $b->getAesHexEmail() === 'user42@example.com', 'one by pk + aes decode');
check($b->getDescription() === null && $b['name'] === 'battle-42', 'lazy column null by default; ArrayAccess');
check($b->getIsClose() === true && $b->getIsDisplay() === false, 'bool coercion (42: closed, not displayed)');
check($b->getMemo('dflt') === 'dflt', 'getX(default) for unknown column');

$b2 = (new Battle)->selectDescription()->seqEq(42)->one($db);
check(str_starts_with((string) $b2->getDescription(), 'desc-42'), 'select lazy column');

$now = '2026-09-11 00:00:00';
$rows = (new Battle)
    ->serviceSeqEq(7)
    ->isCloseEq(false)
    ->and(fn(BattleWhere $w) => $w
        ->isDisplayEq(true)
        ->or()
        ->and(fn(BattleWhere $w) => $w->isDisplayEq(false)->displayStartDtLt($now)))
    ->seqIn([6, 106, 206, 306, 406])
    ->orderBySeqDesc()
    ->limit(0, 3)
    ->all($db);
check(count($rows) === 3 && $rows->first()->getSeq() === 306, 'all + group + or + in + order + limit');
foreach ($rows as $seq => $r) { check($seq === $r->getSeq(), 'collection keyed by pk'); }

check((new Battle)->serviceSeqEq(7)->count($db) === 1000, 'count');
check((new Battle)->serviceSeqEq(7)->sumLikeCount($db) > 0, 'sum');

$cnt = (new Battle)
    ->joinService((new Service)->where(fn(ServiceWhere $w) => $w->nameEq('service-7')))
    ->leftJoinUser((new User)->on(fn(UserWhere $w) => $w->nameContains('user')))
    ->isCloseEq(false)
    ->and(fn(BattleWhere $w) => $w->isDisplayEq(true)->or()->service(fn(ServiceWhere $s) => $s->seqGt(1000)))
    ->count($db);
check($cnt > 0, 'join + on/where + nav');

$page = (new Battle)->serviceSeqEq(7)->orderBySeqAsc()->paginate($db, 2, 10);
check($page->total === 1000 && $page->pages === 100 && count($page->items) === 10 && $page->items->first()->getSeq() === 1006, 'paginate');
check((new Battle)->nameContains('%')->count($db) === 0, 'contains escapes %');

// join result access
$j = (new Battle)->joinService((new Service)->where(fn(ServiceWhere $w) => $w->seqEq(7)))->seqEq(6)->one($db);
check($j !== null && $j->getService() !== null && $j->getService()->getName() === 'service-7' && $j['service']['name'] === 'service-7', 'joined row access');

// ---- relations ----
$n0 = count($log);
$rows = (new Battle)
    ->serviceSeqEq(7)->orderBySeqAsc()->limit(0, 5)
    ->relationUser(new User)
    ->relationService((new Service)
        ->relationsMembers((new ServiceMember)->orderBySeqDesc()->limitPerParent(3)->keyByUserSeq()->dropChildKey()))
    ->all($db);
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
    ->all($db);
check($rows[7]->getUser() !== null && $rows[14]->getUser() !== null && $rows[8]->getUser() === null, 'if_parent loads only closed battles\' users');
check(count($rows[7]->getUser()->getBattles()) === 2, 'nested many under one, limit_per_parent');
check(count($rows[8]->getService()->getModules()) === 1 && $rows[8]->getService()->getModules()->first()->getServiceSeq() === $rows[8]->getServiceSeq(), 'relation off a join');
$n0 = count($log);
check(count((new Battle)->seqEq(0)->relationUser(new User)->all($db)) === 0 && count($log) - $n0 === 1, 'no parents → relation step skipped');
$one = (new Battle)->seqEq(42)->relationService((new Service)->relationsMembers((new ServiceMember)->limitPerParent(1)))->one($db);
check($one !== null && count($one->getService()->getMembers()) === 1, 'one + relation');
$m = (new ServiceMember)->serviceSeqEq(7)->orderBySeqAsc()->limit(0, 2)->relationUser((new User)->flatten())->all($db)->first();
check($m['name'] === 'user-' . $m->getUserSeq() && $m->getName() === 'user-' . $m->getUserSeq() && $m->toArray()['name'] === $m['name'], 'flatten merges child columns into the parent');
$page = (new Battle)->serviceSeqEq(7)->orderBySeqAsc()->relationUser(new User)->paginate($db, 1, 4);
check($page->total === 1000 && count($page->items) === 4 && $page->items->first()->getUser() !== null, 'paginate keeps relations');

// ---- writes ----
$created = $db->transaction(function (Tx $tx) {
    return (new Battle)
        ->setName('php-write')
        ->setUserSeq(1)->setServiceSeq(999)->setServiceModuleSeq(1)->setServiceMemberSeq(1)
        ->setStartDt('2026-06-01 00:00:00')->setEndDt('2026-12-31 00:00:00')
        ->setAesHexEmail('w@example.com')
        ->insert($tx);
});
check($created !== null && $created->getSeq() > 0 && $created->getAesHexEmail() === 'w@example.com', 'insert in tx + aes');

$created->setName('php-write-2')->setLikeCount(5)->updateOptimistic($db);
$again = (new Battle)->oneBySeq($db, $created->getSeq());
check($again->getName() === 'php-write-2' && $again->getLikeCount() === 5, 'dirty update');
try {
    $created->setName('stale')->updateOptimistic($db);
    check(false, 'optimistic lock should fail');
} catch (OrmException $e) {
    check($e->code_ === 'OPTIMISTIC_LOCK', 'optimistic lock code');
}
$again->delete($db);
check((new Battle)->seqEq($created->getSeq())->count($db) === 0, 'delete');

// ---- S3: upsert, save, query update/delete, deleteCascade, sql ----
$draft = fn(string $name, int $readCount = 1) => (new Battle)
    ->setName($name)->setReadCount($readCount)
    ->setUserSeq(1)->setServiceSeq(999)->setServiceModuleSeq(1)->setServiceMemberSeq(1)
    ->setStartDt('2026-06-01 00:00:00')->setEndDt('2026-12-31 00:00:00');
$a = $draft('php-u1')->setUuid('php-upsert')->insert($db);
$b = $draft('php-u2')->setUuid('php-upsert')->onDuplicateSetName('php-u2')->onDuplicatePlusReadCount(5)->insert($db);
check($a !== null && $b !== null && $b->getSeq() === $a->getSeq() && $b->getName() === 'php-u2' && $b->getReadCount() === 6, 'insert on duplicate updates and returns the existing row');
$c = $draft('php-u3', 9)->setUuid('php-upsert')->onDuplicateSetAll()->insert($db);
check($c->getSeq() === $a->getSeq() && $c->getName() === 'php-u3' && $c->getReadCount() === 9, 'onDuplicateSetAll mirrors the draft');
$d = $draft('php-u4')->setUuid('php-upsert')->onDuplicateSetNameExpr('CONCAT(`name`, ?)', ['!'])->onDuplicateMinusReadCount(100)->insert($db);
check($d->getSeq() === $a->getSeq() && $d->getName() === 'php-u3!' && $d->getReadCount() === 0, 'on duplicate expr + minus clamped at 0');
check((new Battle)->seqEq($a->getSeq())->delete($db) === 1 && (new Battle)->seqEq($a->getSeq())->count($db) === 0, 'query delete returns the affected count');

$r = $draft('php-save')->save($db);
check($r !== null && $r->getSeq() > 0 && $r->getName() === 'php-save', 'save without pk inserts');
$r2 = (new Battle)->setSeq($r->getSeq())->setName('php-save-2')->save($db);
check($r2 !== null && $r2->getSeq() === $r->getSeq() && $r2->getName() === 'php-save-2' && $r2->getUserSeq() === 1, 'save with pk updates the other columns only');
check((new Battle)->seqEq($r->getSeq())->plusReadCount(2)->setLikeCount(7)->update($db) === 1, 'query update returns the affected count');
$r3 = (new Battle)->oneBySeq($db, $r->getSeq());
check($r3->getReadCount() === 3 && $r3->getLikeCount() === 7, 'query update applied (read_count 1 + 2)');
try {
    (new Battle)->setName('x')->update($db);
    check(false, 'update without where should throw');
} catch (OrmException $e) {
    check($e->code_ === 'IR_INVALID', 'update without where → IR_INVALID');
}
check((new Battle)->seqEq($r->getSeq())->delete($db) === 1, 'query delete');

$n0 = count($log);
$dump = (new Battle)->serviceSeqEq(7)->selectAesHexEmail()->limit(0, 1)->sql($db);
check(str_starts_with($dump['sql'], 'SELECT ') && $dump['binds'] === ['$SECRET', '$SECRET', 7] && count($log) === $n0, 'sql() dumps the main statement without executing');

$svc = $db->transaction(function (Tx $tx) {
    $s = (new Service)->setName('php-cascade')->insert($tx);
    foreach ([1, 2] as $u) {
        (new ServiceMember)->setServiceSeq($s->getSeq())->setUserSeq($u)->insert($tx);
    }
    (new ServiceModule)->setServiceSeq($s->getSeq())->setName('php-cascade-mod')->insert($tx);
    return $s;
});
$loaded = (new Service)->seqEq($svc->getSeq())
    ->relationsMembers((new ServiceMember)->orderBySeqAsc()->relationUser(new User))
    ->relationsModules((new ServiceModule)->noCascadeDelete())
    ->one($db);
$n0 = count($log);
$loaded->deleteCascade($db);
check(count($log) - $n0 === 3
    && str_starts_with($log[$n0], 'DELETE FROM `service_member`') && str_starts_with($log[$n0 + 1], 'DELETE FROM `service_member`') && str_starts_with($log[$n0 + 2], 'DELETE FROM `service`'),
    'deleteCascade: owned members first, then the service; noCascadeDelete stops at modules; users (parent direction) untouched');
check((new ServiceMember)->serviceSeqEq($svc->getSeq())->count($db) === 0 && (new Service)->seqEq($svc->getSeq())->count($db) === 0
    && (new ServiceModule)->serviceSeqEq($svc->getSeq())->count($db) === 1 && (new User)->seqIn([1, 2])->count($db) === 2, 'deleteCascade result');
check((new ServiceModule)->serviceSeqEq($svc->getSeq())->delete($db) === 1, 'cascade cleanup');

// ---- deadlock gate: two processes, T1 updates A then B, T2 updates B then A ----
$rowA = $draft('dl-php-1')->insert($db);
$rowB = $draft('dl-php-2')->insert($db);
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
$a2 = (new Battle)->oneBySeq($db, $rowA->getSeq());
$b2 = (new Battle)->oneBySeq($db, $rowB->getSeq());
check($a2->getName() === "dl-php-$last" && $b2->getName() === "dl-php-$last", 'final values are the last writer\'s');
$rowA->delete($db);
$rowB->delete($db);
check((new Battle)->seqIn([$rowA->getSeq(), $rowB->getSeq()])->count($db) === 0, 'deadlock rows cleaned up');

// ---- S4: countDistinct/min/max, having, named predicates, raw root ----
check((new Battle)->serviceSeqEq(7)->minSeq($db) === 6 && (new Battle)->serviceSeqEq(7)->maxSeq($db) === 99906, 'min/max return the column type (int)');
check((new Battle)->seqEq(0)->minSeq($db) === null && (new Battle)->seqEq(0)->maxStartDt($db) === null, 'min/max are null when no rows match');
check(preg_match('/^\d{4}-\d\d-\d\d /', (string) (new Battle)->serviceSeqEq(7)->minStartDt($db)) === 1, 'min of a datetime column is its string form');
check((new Battle)->seqEq(0)->maxIp($db) === null && (new Battle)->seqEq(0)->countDistinctIp($db) === 0, 'ip-styled column has the aggregate terminals (engine allows ip); null/0 when no rows');
$du = (new Battle)->serviceSeqEq(7)->countDistinctUserSeq($db);
check($du > 0 && $du <= 1000 && (new Battle)->seqEq(0)->countDistinctUserSeq($db) === 0, 'countDistinct is an int, 0 when no rows');
$groups = (new Battle)->serviceSeqEq(7)->groupByUserSeq()->count($db);
check($groups === $du, 'count with groupBy is the number of groups');
$multi = (new Battle)->serviceSeqEq(7)->groupByUserSeq()->having(fn(BattleWhere $w) => $w->expr('COUNT(*) > ?', [1]))->count($db);
$single = (new Battle)->serviceSeqEq(7)->groupByUserSeq()->having(fn(BattleWhere $w) => $w->expr('COUNT(*) = ?', [1]))->count($db);
check($multi + $single === $groups && $multi > 0, 'having filters the groups (' . $multi . ' multi + ' . $single . ' single)');
check(str_contains((new Battle)->serviceSeqEq(7)->groupByUserSeq()->having(fn(BattleWhere $w) => $w->expr('COUNT(*) > ?', [1]))->sql($db)['sql'], ' HAVING '), 'having is rendered');
try {
    (new Battle)->serviceSeqEq(7)->having(fn(BattleWhere $w) => $w->expr('COUNT(*) > ?', [1]))->count($db);
    check(false, 'having without groupBy should throw');
} catch (OrmException $e) {
    check($e->code_ === 'IR_INVALID', 'having without groupBy → IR_INVALID');
}
try {
    (new Q('battle'))->runScalar($db, 'min', 'aes_hex_email');
    check(false, 'min on a styled column should throw');
} catch (OrmException $e) {
    check($e->code_ === 'OPERATOR_NOT_ALLOWED', 'min on a styled column → OPERATOR_NOT_ALLOWED (no method is generated for it)');
}

$vis = (new Battle)->visible()->serviceSeqEq(7)->count($db);
check($vis > 0 && $vis === (new Battle)->serviceSeqEq(7)->isCloseEq(false)->isDisplayEq(true)->count($db), 'visible() = is_close = 0 AND is_display = 1');
$since = '2026-01-01 00:00:00';
$sa = (new Battle)->startedAfter($since)->serviceSeqEq(7)->count($db);
check($sa === (new Battle)->startDtGt($since)->serviceSeqEq(7)->count($db), 'startedAfter($v) binds its one argument');
$either = (new Battle)->serviceSeqEq(7)->and(fn(BattleWhere $w) => $w->visible()->or()->startedAfter($since))->count($db);
check($either >= max($vis, $sa) && $either <= $vis + $sa, 'named predicates on the Where builder, with or()');
check(str_contains((new Battle)->visible()->sql($db)['sql'], '(`a`.`is_close` = 0 AND `a`.`is_display` = 1)'), 'predicate fragment reaches the SQL with its columns alias-resolved');

$raw = (new Battle)->raw('SELECT COUNT(*) AS n, MAX(seq) AS m FROM {table} WHERE service_seq = ? AND is_close = ?', [7, 0])->rawAll($db);
check(count($raw) === 1 && array_keys($raw[0]) === ['n', 'm'] && $raw[0]['n'] === (new Battle)->serviceSeqEq(7)->isCloseEq(false)->count($db) && is_int($raw[0]['m']), 'rawAll: one row keyed by column name, ints as ints');
$raw2 = (new Battle)->raw('SELECT seq, name FROM {table} WHERE seq IN (?, ?) ORDER BY seq', [42, 6])->rawAll($db);
check(count($raw2) === 2 && $raw2[0]['seq'] === 6 && $raw2[1]['name'] === 'battle-42', 'rawAll: rows in statement order, binds in order');
check((new Battle)->raw('SELECT seq FROM {table} WHERE seq = ?', [0])->rawAll($db) === [], 'rawAll: empty list when nothing matches');
try {
    (new Battle)->raw('SELECT seq FROM {table} WHERE seq = ?', [])->rawAll($db);
    check(false, 'raw with a placeholder/bind mismatch should throw');
} catch (OrmException $e) {
    check($e->code_ === 'IR_INVALID', 'raw placeholder/bind mismatch → IR_INVALID');
}

// ---- error surface ----
try {
    (new Battle)->seqIn([])->count($db);
    check(false, 'EMPTY_IN should throw');
} catch (OrmException $e) {
    check($e->code_ === 'EMPTY_IN', 'EMPTY_IN code');
}

if ($fail === 0) {
    echo "ok — " . count($log) . " statements\n";
    exit(0);
}
foreach ($log as $s) { fwrite(STDERR, "  $s\n"); }
exit(1);
