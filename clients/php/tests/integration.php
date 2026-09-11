<?php
// PHP half of the S1 demo: same statements as clients/go/gen/gen_integration_test.go.
// Usage: php clients/php/tests/integration.php /abs/ormd.sock /abs/schema.json
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Tests\Model\AuthorWhere;
use Polyspec\Orm\Tests\Model\Service;
use Polyspec\Orm\Tests\Model\ServiceMember;
use Polyspec\Orm\Tests\Model\ServiceRegion;
use Polyspec\Orm\Tests\Model\ServiceWhere;
use Polyspec\Orm\Tests\Model\User;
use Polyspec\Orm\Tests\Model\UserWhere;
use Orm\Config;
use Orm\Db;
use Orm\Orm;
use Orm\OrmException;
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
$b = (new Author)->oneBySeq($db, 42);
check($b !== null && $b->getSeq() === 42 && $b->getName() === 'author-42' && $b->getAesHexEmail() === 'user42@example.com', 'one by pk + aes decode');
check($b->getDescription() === null && $b['name'] === 'author-42', 'lazy column null by default; ArrayAccess');
check($b->getIsClose() === true && $b->getIsDisplay() === false, 'bool coercion (42: closed, not displayed)');
check($b->getMemo('dflt') === 'dflt', 'getX(default) for unknown column');

$b2 = (new Author)->selectDescription()->seqEq(42)->one($db);
check(str_starts_with((string) $b2->getDescription(), 'desc-42'), 'select lazy column');

$now = '2026-09-11 00:00:00';
$rows = (new Author)
    ->serviceSeqEq(7)
    ->isCloseEq(false)
    ->and(fn(AuthorWhere $w) => $w
        ->isDisplayEq(true)
        ->or()
        ->and(fn(AuthorWhere $w) => $w->isDisplayEq(false)->displayStartDtLt($now)))
    ->seqIn([6, 106, 206, 306, 406])
    ->orderBySeqDesc()
    ->limit(0, 3)
    ->all($db);
check(count($rows) === 3 && $rows->first()->getSeq() === 306, 'all + group + or + in + order + limit');
foreach ($rows as $seq => $r) { check($seq === $r->getSeq(), 'collection keyed by pk'); }

check((new Author)->serviceSeqEq(7)->count($db) === 1000, 'count');
check((new Author)->serviceSeqEq(7)->sumLikeCount($db) > 0, 'sum');

$cnt = (new Author)
    ->joinService((new Service)->where(fn(ServiceWhere $w) => $w->nameEq('service-7')))
    ->leftJoinUser((new User)->on(fn(UserWhere $w) => $w->nameContains('user')))
    ->isCloseEq(false)
    ->and(fn(AuthorWhere $w) => $w->isDisplayEq(true)->or()->service(fn(ServiceWhere $s) => $s->seqGt(1000)))
    ->count($db);
check($cnt > 0, 'join + on/where + nav');

$page = (new Author)->serviceSeqEq(7)->orderBySeqAsc()->paginate($db, 2, 10);
check($page->total === 1000 && $page->pages === 100 && count($page->items) === 10 && $page->items->first()->getSeq() === 1006, 'paginate');
check((new Author)->nameContains('%')->count($db) === 0, 'contains escapes %');

// join result access
$j = (new Author)->joinService((new Service)->where(fn(ServiceWhere $w) => $w->seqEq(7)))->seqEq(6)->one($db);
check($j !== null && $j->getService() !== null && $j->getService()->getName() === 'service-7' && $j['service']['name'] === 'service-7', 'joined row access');

// ---- relations ----
$n0 = count($log);
$rows = (new Author)
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
$rows = (new Author)
    ->seqIn([7, 8, 14])->orderBySeqAsc()
    ->relationUser((new User)->ifParentIsCloseEq(true)->relationsAuthors((new Author)->orderBySeqAsc()->limitPerParent(2)))
    ->joinService((new Service)->relationsModules(new ServiceRegion))
    ->all($db);
check($rows[7]->getUser() !== null && $rows[14]->getUser() !== null && $rows[8]->getUser() === null, 'if_parent loads only closed authors\' users');
check(count($rows[7]->getUser()->getAuthors()) === 2, 'nested many under one, limit_per_parent');
check(count($rows[8]->getService()->getModules()) === 1 && $rows[8]->getService()->getModules()->first()->getServiceSeq() === $rows[8]->getServiceSeq(), 'relation off a join');
$n0 = count($log);
check(count((new Author)->seqEq(0)->relationUser(new User)->all($db)) === 0 && count($log) - $n0 === 1, 'no parents → relation step skipped');
$one = (new Author)->seqEq(42)->relationService((new Service)->relationsMembers((new ServiceMember)->limitPerParent(1)))->one($db);
check($one !== null && count($one->getService()->getMembers()) === 1, 'one + relation');
$m = (new ServiceMember)->serviceSeqEq(7)->orderBySeqAsc()->limit(0, 2)->relationUser((new User)->flatten())->all($db)->first();
check($m['name'] === 'user-' . $m->getUserSeq() && $m->getName() === 'user-' . $m->getUserSeq() && $m->toArray()['name'] === $m['name'], 'flatten merges child columns into the parent');
$page = (new Author)->serviceSeqEq(7)->orderBySeqAsc()->relationUser(new User)->paginate($db, 1, 4);
check($page->total === 1000 && count($page->items) === 4 && $page->items->first()->getUser() !== null, 'paginate keeps relations');

// ---- writes ----
$created = $db->transaction(function (Tx $tx) {
    return (new Author)
        ->setName('php-write')
        ->setUserSeq(1)->setServiceSeq(999)->setServiceRegionSeq(1)->setServiceMemberSeq(1)
        ->setStartDt('2026-06-01 00:00:00')->setEndDt('2026-12-31 00:00:00')
        ->setAesHexEmail('w@example.com')
        ->insert($tx);
});
check($created !== null && $created->getSeq() > 0 && $created->getAesHexEmail() === 'w@example.com', 'insert in tx + aes');

$created->setName('php-write-2')->setLikeCount(5)->updateOptimistic($db);
$again = (new Author)->oneBySeq($db, $created->getSeq());
check($again->getName() === 'php-write-2' && $again->getLikeCount() === 5, 'dirty update');
try {
    $created->setName('stale')->updateOptimistic($db);
    check(false, 'optimistic lock should fail');
} catch (OrmException $e) {
    check($e->code_ === 'OPTIMISTIC_LOCK', 'optimistic lock code');
}
$again->delete($db);
check((new Author)->seqEq($created->getSeq())->count($db) === 0, 'delete');

// ---- S3: upsert, save, query update/delete, deleteCascade, sql ----
$draft = fn(string $name, int $readCount = 1) => (new Author)
    ->setName($name)->setReadCount($readCount)
    ->setUserSeq(1)->setServiceSeq(999)->setServiceRegionSeq(1)->setServiceMemberSeq(1)
    ->setStartDt('2026-06-01 00:00:00')->setEndDt('2026-12-31 00:00:00');
$a = $draft('php-u1')->setUuid('php-upsert')->insert($db);
$b = $draft('php-u2')->setUuid('php-upsert')->onDuplicateSetName('php-u2')->onDuplicatePlusReadCount(5)->insert($db);
check($a !== null && $b !== null && $b->getSeq() === $a->getSeq() && $b->getName() === 'php-u2' && $b->getReadCount() === 6, 'insert on duplicate updates and returns the existing row');
$c = $draft('php-u3', 9)->setUuid('php-upsert')->onDuplicateSetAll()->insert($db);
check($c->getSeq() === $a->getSeq() && $c->getName() === 'php-u3' && $c->getReadCount() === 9, 'onDuplicateSetAll mirrors the draft');
$d = $draft('php-u4')->setUuid('php-upsert')->onDuplicateSetNameExpr('CONCAT(`name`, ?)', ['!'])->onDuplicateMinusReadCount(100)->insert($db);
check($d->getSeq() === $a->getSeq() && $d->getName() === 'php-u3!' && $d->getReadCount() === 0, 'on duplicate expr + minus clamped at 0');
check((new Author)->seqEq($a->getSeq())->delete($db) === 1 && (new Author)->seqEq($a->getSeq())->count($db) === 0, 'query delete returns the affected count');

$r = $draft('php-save')->save($db);
check($r !== null && $r->getSeq() > 0 && $r->getName() === 'php-save', 'save without pk inserts');
$r2 = (new Author)->setSeq($r->getSeq())->setName('php-save-2')->save($db);
check($r2 !== null && $r2->getSeq() === $r->getSeq() && $r2->getName() === 'php-save-2' && $r2->getUserSeq() === 1, 'save with pk updates the other columns only');
check((new Author)->seqEq($r->getSeq())->plusReadCount(2)->setLikeCount(7)->update($db) === 1, 'query update returns the affected count');
$r3 = (new Author)->oneBySeq($db, $r->getSeq());
check($r3->getReadCount() === 3 && $r3->getLikeCount() === 7, 'query update applied (read_count 1 + 2)');
try {
    (new Author)->setName('x')->update($db);
    check(false, 'update without where should throw');
} catch (OrmException $e) {
    check($e->code_ === 'IR_INVALID', 'update without where → IR_INVALID');
}
check((new Author)->seqEq($r->getSeq())->delete($db) === 1, 'query delete');

$n0 = count($log);
$dump = (new Author)->serviceSeqEq(7)->selectAesHexEmail()->limit(0, 1)->sql($db);
check(str_starts_with($dump['sql'], 'SELECT ') && $dump['binds'] === ['$SECRET', '$SECRET', 7] && count($log) === $n0, 'sql() dumps the main statement without executing');

$svc = $db->transaction(function (Tx $tx) {
    $s = (new Service)->setName('php-cascade')->insert($tx);
    foreach ([1, 2] as $u) {
        (new ServiceMember)->setServiceSeq($s->getSeq())->setUserSeq($u)->insert($tx);
    }
    (new ServiceRegion)->setServiceSeq($s->getSeq())->setName('php-cascade-mod')->insert($tx);
    return $s;
});
$loaded = (new Service)->seqEq($svc->getSeq())
    ->relationsMembers((new ServiceMember)->orderBySeqAsc()->relationUser(new User))
    ->relationsModules((new ServiceRegion)->noCascadeDelete())
    ->one($db);
$n0 = count($log);
$loaded->deleteCascade($db);
check(count($log) - $n0 === 3
    && str_starts_with($log[$n0], 'DELETE FROM `service_member`') && str_starts_with($log[$n0 + 1], 'DELETE FROM `service_member`') && str_starts_with($log[$n0 + 2], 'DELETE FROM `service`'),
    'deleteCascade: owned members first, then the service; noCascadeDelete stops at modules; users (parent direction) untouched');
check((new ServiceMember)->serviceSeqEq($svc->getSeq())->count($db) === 0 && (new Service)->seqEq($svc->getSeq())->count($db) === 0
    && (new ServiceRegion)->serviceSeqEq($svc->getSeq())->count($db) === 1 && (new User)->seqIn([1, 2])->count($db) === 2, 'deleteCascade result');
check((new ServiceRegion)->serviceSeqEq($svc->getSeq())->delete($db) === 1, 'cascade cleanup');

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
$a2 = (new Author)->oneBySeq($db, $rowA->getSeq());
$b2 = (new Author)->oneBySeq($db, $rowB->getSeq());
check($a2->getName() === "dl-php-$last" && $b2->getName() === "dl-php-$last", 'final values are the last writer\'s');
$rowA->delete($db);
$rowB->delete($db);
check((new Author)->seqIn([$rowA->getSeq(), $rowB->getSeq()])->count($db) === 0, 'deadlock rows cleaned up');

// ---- error surface ----
try {
    (new Author)->seqIn([])->count($db);
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
