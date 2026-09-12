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
use App\Orm\Account;
use App\Orm\AccountProject;
use App\Orm\Project;
use App\Orm\CompositeAccount;
use App\Orm\CompositeMembership;
use App\Orm\CompositeMembershipWhere;
use App\Orm\Service;
use App\Orm\ServiceMember;
use App\Orm\ServiceModule;
use App\Orm\ServiceWhere;
use App\Orm\SoftRecord;
use App\Orm\User;
use App\Orm\UserWhere;
use Orm\Code;
use Orm\Codec;
use Orm\Config;
use Orm\Db;
use Orm\AesKeyring;
use Orm\BatchOptions;
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
Orm::init(new Config(socket: $sock, schemaPath: $schema, aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index', driver: $driver,
    planCacheSize: 2,
    statementCacheSize: 2,
    onQuery: function (string $sql, array $binds, float $sec, string $planId, ?\Throwable $e) use (&$log, &$hooked) { $log[] = orm_norm_sql($sql); $hooked[] = [$binds, $planId, $e]; }));
$db = orm_open_db($driver, orm_test_dsn());
check($db->driver() === $driver, 'Db::driver()');
$db->stmt('SELECT 110');
$db->stmt('SELECT 110');
$db->stmt('SELECT 120');
$db->stmt('SELECT 130');
$statementCache = (new \ReflectionProperty(Db::class, 'stmts'))->getValue($db);
check(count($statementCache) === 2 && !isset($statementCache['SELECT 110']), 'PHP statement cache eviction');
$cacheRequests = [new Q('battle'), new Q('battle'), new Q('battle')];
foreach (['all', 'count', 'one'] as $i => $kind) {
    Orm::transport()->planFor($cacheRequests[$i]->req, $kind);
}
$planCache = (new \ReflectionProperty(\Orm\Transport::class, 'local'))->getValue(Orm::transport());
check(count($planCache) === 2 && !array_key_exists("all\x1fbattle\x1f0", $planCache), 'PHP plan cache bound and oldest eviction');
$emptyBatch = $db->batchWrite([], 'insert', new BatchOptions(1));
check($emptyBatch->attempted === 0 && $emptyBatch->affected === 0 && $emptyBatch->inserted === 0, 'PHP empty batch result');
$invalidBatchRejected = false;
try { $db->batchWrite([], 'merge'); } catch (OrmException $e) { $invalidBatchRejected = $e->code_ === Code::CONFIG; }
check($invalidBatchRejected, 'PHP invalid batch kind rejection');
// A precompiled plan loaded for the same request shape is returned from the local cache.
$bundleQuery = new Q('battle');
$bundleRequest = $bundleQuery->req;
$bundlePlan = Orm::transport()->plan($bundleRequest->shape('all'));
$bundleRequestHash = hash('sha256', json_encode(['entity' => 'battle', 'ir_version' => 1, 'kind' => 'all', 'n_params' => 0, 'schema_hash' => Orm::config()->schemaHash()], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
Orm::transport()->loadPlanBundle(['version' => 1, 'schema_hash' => Orm::config()->schemaHash(), 'dialect' => $driver, 'request_sha256' => $bundleRequestHash, 'plan' => $bundlePlan], $bundleRequest, 'all');
check(Orm::transport()->planFor($bundleRequest, 'all')['kind'] === 'all', 'precompiled plan cache load');
/** the binds sql() and the hook show for the aes select: the key twice on MySQL (AES in SQL), nothing else elsewhere (host AES) */
$aesBinds = [7];

$fail = 0;
function check(bool $ok, string $what): void { global $fail; if (!$ok) { $fail++; fwrite(STDERR, "FAIL: $what\n"); } }

// ---- reads ----
$b = Battle::query()->using($db)->getBySeq(42);
check($b !== null && $b->getSeq() === 42 && $b->getName() === 'battle-42' && $b->getAesHexEmail() === 'user42@example.com', 'one by pk + aes decode');
check($b->getDescription() === null && $b['name'] === 'battle-42', 'lazy column null by default; ArrayAccess');
check(Battle::query()->using($db)->getsByAesHexEmail('user42@example.com')->first()?->getSeq() === 42, 'AES equality uses blind index');
check($b->getIsClose() === true && $b->getIsDisplay() === false, 'bool coercion (42: closed, not displayed)');
check($b->getDescription('dflt') === 'dflt', 'getX(default) for lazy column');

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
$largeIds = range(1006, 2005);
check(Battle::query()->seqIn($largeIds)->using($db)->getCount() === 1000, 'large root IN count is chunked');
check(count(Battle::query()->seqIn($largeIds)->using($db)->gets()) === 1000, 'large root IN rows are merged');
check(Battle::query()->nameContains('battle')->seqIn($largeIds)->using($db)->getCount() === 1000, 'large root IN preserves other predicates');
check(Battle::query()->serviceSeq(7)->using($db)->sumLikeCount() > 0, 'sum');

$cnt = Battle::query()
    ->joinServiceSeqWithSeq(Service::query()->where(fn(ServiceWhere $w) => $w->name('service-7')))
    ->leftJoinUserSeqWithSeq(User::query()->on(fn(UserWhere $w) => $w->nameContains('user')))
    ->isClose(false)
    ->and(fn(BattleWhere $w) => $w->isDisplay(true)->or()->service(fn(ServiceWhere $s) => $s->seqGt(1000)))
    ->using($db)->getCount();
check($cnt > 0, 'join + on/where + nav');

$page = Battle::query()->serviceSeq(7)->orderBySeqAsc()->using($db)->paginate(2, 10);
check($page->total === 1000 && $page->pages === 100 && count($page->items) === 10 && $page->items->first()->getSeq() === 1006, 'paginate');
$firstKeyset = Battle::query()->serviceSeq(7)->orderBySeqAsc()->using($db)->getsAfter('', 2);
$secondKeyset = Battle::query()->serviceSeq(7)->orderBySeqAsc()->using($db)->getsAfter($firstKeyset->nextCursor, 2);
check(count($firstKeyset->items) === 2 && $firstKeyset->nextCursor !== '' && $secondKeyset->items->first()->getSeq() > $firstKeyset->items->first()->getSeq(), 'keyset after is ordered and exclusive');
$previousKeyset = Battle::query()->serviceSeq(7)->orderBySeqAsc()->using($db)->getsBefore($secondKeyset->previousCursor, 2);
check($previousKeyset->items->first()->getSeq() === $firstKeyset->items->first()->getSeq(), 'keyset before restores request order');
check(Battle::query()->nameContains('%')->using($db)->getCount() === 0, 'contains escapes %');

// join result access
$j = Battle::query()->joinServiceSeqWithSeq(Service::query()->where(fn(ServiceWhere $w) => $w->seq(7)))->seq(6)->using($db)->get();
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
    Battle::query()->relationUserSeqWithSeq(User::query())->using($db)->stream(fn($row): bool => true);
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
    ->relationUserSeqWithSeq(User::query())
    ->relationServiceSeqWithSeq(Service::query()
        ->relationsSeqWithServiceSeqToServiceMember(ServiceMember::query()->orderBySeqDesc()->limitPerParent(3)->keyByUserSeq()->dropChildKey()))
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
    ->relationUserSeqWithSeq(User::query()->ifParentIsCloseEq(true)->relationsSeqWithUserSeqToBattle(Battle::query()->orderBySeqAsc()->limitPerParent(2)))
    ->joinServiceSeqWithSeq(Service::query()->relationsSeqWithServiceSeqToServiceModule(ServiceModule::query()))
    ->using($db)->gets();
check($rows[7]->getUser() !== null && $rows[14]->getUser() !== null && $rows[8]->getUser() === null, 'if_parent loads only closed battles\' users');
check(count($rows[7]->getUser()->getBattles()) === 2, 'nested many under one, limit_per_parent');
check(count($rows[8]->getService()->getModules()) === 1 && $rows[8]->getService()->getModules()->first()->getServiceSeq() === $rows[8]->getServiceSeq(), 'relation off a join');
$n0 = count($log);
check(count(Battle::query()->seq(0)->relationUserSeqWithSeq(User::query())->using($db)->gets()) === 0 && count($log) - $n0 === 1, 'no parents → relation step skipped');
$one = Battle::query()->seq(42)->relationServiceSeqWithSeq(Service::query()->relationsSeqWithServiceSeqToServiceMember(ServiceMember::query()->limitPerParent(1)))->using($db)->get();
check($one !== null && count($one->getService()->getMembers()) === 1, 'one + relation');
$m = ServiceMember::query()->serviceSeq(7)->orderBySeqAsc()->limit(0, 2)->relationUserSeqWithSeq(User::query()->flatten())->using($db)->gets()->first();
check($m['name'] === 'user-' . $m->getUserSeq() && $m->toArray()['name'] === $m['name'], 'flatten merges child columns into the parent');
$page = Battle::query()->serviceSeq(7)->orderBySeqAsc()->relationUserSeqWithSeq(User::query())->using($db)->paginate(1, 4);
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

$db->transaction(function (Tx $tx): void {
    $tx->savepoint('php_probe');
    $tx->rollbackTo('php_probe');
    $tx->releaseSavepoint('php_probe');
    try {
        $tx->savepoint('php_probe; DROP TABLE battle');
        check(false, 'savepoint identifier injection was accepted');
    } catch (OrmException $e) {
        check($e->code_ === Code::CONFIG, 'savepoint identifier error code');
    }
});
if ($driver === 'sqlite') {
    try {
        $db->transaction(static function (Tx $tx): void {}, new \Orm\TransactionOptions(isolation: 'serializable'));
        check(false, 'SQLite accepted unsupported transaction isolation');
    } catch (OrmException $e) {
        check($e->code_ === Code::CAPABILITY_UNSUPPORTED, 'SQLite transaction capability error code');
    }
    try {
        $db->transaction(static function (Tx $tx): void {}, new \Orm\TransactionOptions(timeoutMs: 1));
        check(false, 'SQLite accepted unsupported transaction timeout');
    } catch (OrmException $e) {
        check($e->code_ === Code::CAPABILITY_UNSUPPORTED, 'SQLite transaction timeout capability error code');
    }
}
if ($driver === 'postgres') {
    try {
        $db->transaction(static fn(Tx $tx) => Battle::query()->raw('SELECT pg_sleep(0.1)')->using($tx)->rawAll(), new \Orm\TransactionOptions(timeoutMs: 1));
        check(false, 'PostgreSQL transaction timeout was not enforced');
    } catch (\Throwable $e) {
        check(str_contains($e->getMessage(), '57014') || str_contains(strtolower($e->getMessage()), 'statement timeout'), 'PostgreSQL transaction timeout returned a detailed driver error');
    }
}

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

$batchPrefix = 'pb-' . bin2hex(random_bytes(8));
$batchDraft = fn(string $uuid, string $name, int $readCount = 1) => $draft($name, $readCount)->setUuid($uuid);
$batchCleanup = function () use ($db, $batchPrefix): void {
    foreach (['insert', 'insert-2', 'upsert', 'rollback'] as $suffix) {
        Battle::query()->uuidEq($batchPrefix . '-' . $suffix)->using($db)->delete();
    }
};
$batchCleanup();
$batchInserted = Battle::query()->using($db)->batchInsert([
    $batchDraft($batchPrefix . '-insert', 'batch-1'),
    $batchDraft($batchPrefix . '-insert-2', 'batch-2', 2),
], new BatchOptions(1));
check($batchInserted->attempted === 2 && $batchInserted->affected === 2 && $batchInserted->inserted === 2, 'batch insert result');
$batchRow = Battle::query()->uuidEq($batchPrefix . '-insert')->using($db)->get();
check($batchRow !== null, 'batch insert row');
$batchUpsert = Battle::query()->using($db)->batchUpsert([$batchDraft($batchPrefix . '-upsert', 'upsert-1')], new BatchOptions(1));
check($batchUpsert->attempted === 1 && $batchUpsert->affected === 1 && $batchUpsert->inserted === 1, 'batch upsert insert result');
$batchUpsert = Battle::query()->using($db)->batchUpsert([
    $batchDraft($batchPrefix . '-upsert', 'upsert-2', 9)->onDuplicateSetName('upsert-2'),
], new BatchOptions(1));
check($batchUpsert->attempted === 1 && $batchUpsert->affected === 1, 'batch upsert update result');
$batchUpdated = Battle::query()->using($db)->batchUpdate([
    Battle::query()->seqEq($batchRow->getSeq())->setName('batch-updated'),
], new BatchOptions(1));
check($batchUpdated->attempted === 1 && $batchUpdated->affected === 1, 'batch update result');
$batchDeleted = Battle::query()->using($db)->batchDelete([
    Battle::query()->seqEq($batchRow->getSeq()),
    Battle::query()->uuidEq($batchPrefix . '-insert-2'),
], new BatchOptions(1));
check($batchDeleted->attempted === 2 && $batchDeleted->affected === 2, 'batch delete result');
$batchRollbackFailed = false;
try {
    Battle::query()->using($db)->batchInsert([
        $batchDraft($batchPrefix . '-rollback', 'rollback-1'),
        $batchDraft($batchPrefix . '-rollback', 'rollback-2', 2),
    ], new BatchOptions(1));
} catch (\Throwable) { $batchRollbackFailed = true; }
check($batchRollbackFailed && Battle::query()->uuidEq($batchPrefix . '-rollback')->using($db)->getCount() === 0, 'batch rollback');
$batchCleanup();

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
    ->relationsSeqWithServiceSeqToServiceMember(ServiceMember::query()->orderBySeqAsc()->relationUserSeqWithSeq(User::query()))
    ->relationsSeqWithServiceSeqToServiceModule(ServiceModule::query()->noCascadeDelete())
    ->using($db)->get();
$n0 = count($log);
try {
    $loaded->using($db)->deleteCascade();
    check(false, 'noCascadeDelete must report the foreign-key restriction');
} catch (OrmException $e) {
    check($e->code_ === Code::FOREIGN_KEY, 'noCascadeDelete reports the foreign-key restriction');
}
check(count($log) - $n0 === 3
    && ServiceMember::query()->serviceSeq($svc->getSeq())->using($db)->getCount() === 2
    && Service::query()->seq($svc->getSeq())->using($db)->getCount() === 1
    && ServiceModule::query()->serviceSeq($svc->getSeq())->using($db)->getCount() === 1,
    'deleteCascade failure rolls back owned members and retains the service and module');
check(ServiceModule::query()->serviceSeq($svc->getSeq())->using($db)->delete() === 1, 'cascade cleanup');
$loaded->using($db)->deleteCascade();
check(ServiceMember::query()->serviceSeq($svc->getSeq())->using($db)->getCount() === 0
    && Service::query()->seq($svc->getSeq())->using($db)->getCount() === 0
    && User::query()->seqIn([1, 2])->using($db)->getCount() === 2, 'deleteCascade succeeds after module cleanup');

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
    Orm::init(new Config(socket: $sock, schemaPath: $schema, aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index', driver: $driver));
    check(false, 'wrong generated hash should throw');
} catch (OrmException $e) {
    check($e->code_ === Code::SCHEMA_HASH_MISMATCH, 'generated hash ≠ schema.json → SCHEMA_HASH_MISMATCH');
}
Registry::generated(json_decode(file_get_contents($schema), true)['schema_hash']);
try {
    Orm::init(new Config(socket: $sock, schemaPath: $schema, aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index', driver: $driver === 'mysql' ? 'sqlite' : 'mysql'));
    check(false, 'a driver other than the ormd dialect should throw');
} catch (OrmException $e) {
    check(
        $e->code_ === Code::CONFIG
        && str_contains($e->getMessage(), 'compiles for')
        && str_contains($e->getMessage(), 'driver is'),
        'driver ≠ ormd dialect → CONFIG'
    );
}
Orm::init(new Config(socket: $sock, schemaPath: $schema, aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index', driver: $driver));
try {
    orm_open_db($driver === 'sqlite' ? 'mysql' : 'sqlite', $driver === 'sqlite' ? orm_default_dsn('mysql') : '/nonexistent/orm.sqlite');
    check(false, 'a Db of another driver than the config should throw');
} catch (OrmException $e) {
    check($e->code_ === Code::CONFIG, 'Db driver ≠ configured driver → CONFIG (' . $e->getMessage() . ')');
}

// ---- S5: orm.toml ----
$toml = function (string $schemaLine, string $extra = '') use ($sock, $driver): string {
    $f = tempnam(sys_get_temp_dir(), 'orm-toml-');
    // MySQL uses explicit root credentials; PostgreSQL credentials remain in the DSN so the test works with any database user.
    $cred = $driver === 'mysql' ? "user = \"root\"\npassword = \"\"\n" : '';
    file_put_contents($f, "$schemaLine\n[db]\ndriver = \"$driver\"\ndsn = \"" . orm_test_dsn() . "\"\n{$cred}pool = 8   # ignored by PHP\n[secrets]\naes = \"bench-salt\"\nblind_index = \"bench-blind-index\"\n[ormd]\nsocket = \"$sock\"\n[debug]\non_query = false\n$extra");
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
file_put_contents($versioned, str_replace("aes = \"bench-salt\"\nblind_index", "aes_version = 2\nblind_index", file_get_contents($versioned)));
file_put_contents($versioned, str_replace("blind_index = \"bench-blind-index\"", "blind_index = \"bench-blind-index\"\n[secrets.aes_keys]\n1 = \"old-key\"\n2 = \"bench-salt\"", file_get_contents($versioned)));
$db3 = Orm::fromConfig($versioned);
unlink($versioned);
check($db3 instanceof Db && Orm::config()->aesKey === 'bench-salt' && Orm::config()->aesVersion === 2, 'fromConfig loads [secrets.aes_keys] and aes_version');
Orm::init(new Config(socket: $sock, schemaPath: $schema, aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index', driver: $driver,
    onQuery: function (string $sql, array $binds, float $sec, string $planId, ?\Throwable $e) use (&$log) { $log[] = $sql; }));

// ---- S6: host-side styles round trip on this database (aes/hex in SQL on MySQL, app-side elsewhere; ip packed on SQLite) ----
$hb = $draft('php-host')->setAesHexEmail('한글@example.com')->setAesHexPhone('')->setIp('2001:db8::1')->using($db)->insert();
check($hb->getAesHexEmail() === '한글@example.com' && $hb->getAesHexPhone() === '' && $hb->getIp() === '2001:db8::1', 'aes_hex and ip written by this executor read back equal (' . $driver . ')');
$rawHex = Battle::query()->raw('SELECT aes_hex_email AS h FROM {table} WHERE seq = ?', [$hb->getSeq()])->using($db)->rawAll()[0]['h'];
check(Codec::hostDecode($rawHex, ['aes', 'hex'], 'bench-salt') === '한글@example.com', 'the stored aes_hex value decodes with the host codec');
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
$accounts = CompositeAccount::query()->tenantIdEq($tenantId)->orderByAccountIdAsc()->relationsTenantIdWithTenantIdAndAccountIdWithAccountId(CompositeMembership::query())->using($db)->gets();
check(count($accounts) === 2 && count($accounts->first()?->getMemberships()) === 1, 'composite relation uses every key component');
$relationAccounts = CompositeAccount::query()->tenantId($tenantId)->hasMemberships(static function (CompositeMembershipWhere $w): void {})->using($db)->getCount();
check($relationAccounts === 2, 'relation exists predicate');
$relationCount = CompositeAccount::query()->tenantId($tenantId)->countMembershipsEq(1, static function (CompositeMembershipWhere $w): void {})->using($db)->getCount();
check($relationCount === 2, 'relation count predicate');
$m2mAvailable = true;
try { $db->pdo->query('SELECT 1 FROM account LIMIT 0'); } catch (\PDOException) { $m2mAvailable = false; }
if ($m2mAvailable) {
    $m2mAccount = Account::query()->setName('m2m-account')->using($db)->insert();
    $m2mProject = Project::query()->setName('m2m-project')->using($db)->insert();
    AccountProject::query()->setAccountSeq($m2mAccount->getSeq())->setProjectSeq($m2mProject->getSeq())->using($db)->insert();
    $linked = Account::query()->seq($m2mAccount->getSeq())->relationsSeqWithSeq(Project::query())->using($db)->gets();
    check(count($linked) === 1 && count($linked->first()->getProjects()) === 1 && $linked->first()->getProjects()->first()->getSeq() === $m2mProject->getSeq(), 'many-to-many relation uses through entity');
    AccountProject::query()->accountSeq($m2mAccount->getSeq())->using($db)->delete();
    Project::query()->seq($m2mProject->getSeq())->using($db)->delete();
    Account::query()->seq($m2mAccount->getSeq())->using($db)->delete();
}
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
$soft = SoftRecord::query()->setName('soft-delete')->using($db)->insert();
check($soft !== null && SoftRecord::query()->using($db)->getCount() === 1, 'soft-delete insert is visible');
if ($soft !== null) $soft->delete();
check($soft !== null && SoftRecord::query()->using($db)->getCount() === 0 && SoftRecord::query()->using($db)->getBySeq($soft->getSeq()) === null, 'soft-delete row is hidden after delete');
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
$rotationSpec = ['table' => $rotationTable, 'primary_keys' => ['tenant_id', 'id'], 'version_column' => 'aes_key_version', 'columns' => [['name' => 'aes_hex_email', 'styles' => ['aes', 'hex']], ['name' => 'aes_hex_phone', 'styles' => ['aes', 'hex']]], 'batch_size' => 1];
$keyring = new AesKeyring([1 => 'rotation-key-v1', 2 => 'rotation-key-v2'], 2);
$before = $db->aesStatus($rotationSpec, $keyring);
$changed = $db->rotateAESRows($rotationSpec, $keyring);
$resumed = $db->rotateAESRows($rotationSpec, $keyring);
$after = $db->aesStatus($rotationSpec, $keyring);
$repeated = $db->rotateAESRows($rotationSpec, $keyring);
$stored = $db->pdo->query('SELECT ' . $quote('aes_key_version') . ', ' . $quote('aes_hex_email') . ', ' . $quote('aes_hex_phone') . ' FROM ' . $quote($rotationTable) . ' WHERE ' . $quote('tenant_id') . ' = 7 AND ' . $quote('id') . ' = 1')->fetch(\PDO::FETCH_NUM);
check($before->total === 2 && $before->pending === 2 && $before->versions[1] === 2, 'AES status reports the stored source version');
check($changed === 1 && $resumed === 1 && $after->pending === 0 && $after->versions[2] === 2 && $repeated === 0, 'AES rotation is bounded and resumable');
check((int) $stored[0] === 2 && Codec::hostDecode($stored[1], ['aes', 'hex'], 'rotation-key-v2') === 'member@example.test' && Codec::hostDecode($stored[2], ['aes', 'hex'], 'rotation-key-v2') === '01012345678', 'AES rotation stores every AES column with the current key');
$db->pdo->exec('DROP TABLE ' . $quote($rotationTable));

$db->close();
try {
    $db->stmt('SELECT 140');
    check(false, 'closed PHP database accepted a statement');
} catch (OrmException $e) {
    check($e->code_ === Code::CONFIG, 'PHP statement cache close error');
}
Orm::transport()->close();
try {
    Orm::transport()->planFor(Battle::query()->req, 'all');
    check(false, 'closed PHP compiler transport accepted a plan');
} catch (OrmException $e) {
    check($e->code_ === Code::CONFIG, 'PHP plan cache close error');
}

if ($fail === 0) {
    echo "ok — " . count($log) . " statements\n";
    exit(0);
}
foreach ($log as $s) { fwrite(STDERR, "  $s\n"); }
exit(1);
