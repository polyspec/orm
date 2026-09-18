<?php
// Model integration test: runs on SQLite always and on MySQL and PostgreSQL
// when ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN name an empty test database.
// Usage: php clients/php/tests/model_test.php
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use App\Orm\Account;
use App\Orm\Battle;
use App\Orm\CompositeAccount;
use App\Orm\CompositeMembership;
use App\Orm\Service;
use App\Orm\ServiceMember;
use App\Orm\ServiceModule;
use App\Orm\User;
use Orm\AesKeyring;
use Orm\Code;
use Orm\Collection;
use Orm\Config;
use Orm\Db;
use Orm\Orm;
use Orm\OrmException;

$root = dirname(__DIR__, 3);
$schema = "$root/schema/schema.json";
$work = sys_get_temp_dir() . '/orm-php-model-' . getmypid();
@mkdir($work, 0o700, true);
$tables = ['account_project', 'composite_membership', 'composite_account', 'battle', 'service_member', 'service_module', 'soft_record', 'account', 'project', 'user', 'service'];

$failures = 0;
function check(bool $ok, string $message): void
{
    global $failures, $current;
    if (!$ok) {
        $failures++;
        fwrite(STDERR, "FAIL $current: $message\n");
    }
}

function code(callable $fn): string
{
    try {
        $fn();
    } catch (OrmException $e) {
        return $e->code_;
    }
    return 'no error';
}

register_shutdown_function(static function () use ($work): void {
    foreach (glob("$work/*") ?: [] as $file) {
        @unlink($file);
    }
    @rmdir($work);
});

function database(string $driver, string $dsn): Db
{
    global $schema, $tables;
    [, $pdoDsn, $user, $password] = Orm::parseDsn($dsn);
    $raw = new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    if ($driver === 'mysql') {
        $raw->exec('SET FOREIGN_KEY_CHECKS = 0');
    }
    foreach ($tables as $table) {
        $raw->exec($driver === 'postgres' ? "DROP TABLE IF EXISTS \"$table\" CASCADE" : ($driver === 'mysql' ? "DROP TABLE IF EXISTS `$table`" : "DROP TABLE IF EXISTS \"$table\""));
    }
    if ($driver === 'mysql') {
        $raw->exec('SET FOREIGN_KEY_CHECKS = 1');
    }
    $raw = null;
    $db = Orm::connect($dsn, new Config(schemaPath: $schema, aesKey: 'test-aes-key', blindIndexKey: 'test-blind-key'));
    $db->utils()->schema()->install((string) file_get_contents($schema));
    return $db;
}

$targets = ['sqlite' => "sqlite://$work/model.sqlite?timezone=%2B00:00"];
foreach (['mysql' => 'ORM_TEST_MYSQL_DSN', 'postgres' => 'ORM_TEST_POSTGRES_DSN'] as $driver => $env) {
    $v = getenv($env);
    if (is_string($v) && $v !== '') {
        $targets[$driver] = $v;
    }
}

$start = new DateTimeImmutable('2026-01-02 03:04:05', new DateTimeZone('UTC'));

/** @return array{service: Service, member: ServiceMember, module: ServiceModule, users: list<User>, battles: list<Battle>} */
function seed(Db $db): array
{
    global $start;
    $f = ['users' => [], 'battles' => []];
    $f['service'] = (new Service)->connect($db)->setName('service')->create();
    foreach (['kim', 'lee', 'park'] as $name) {
        $f['users'][] = (new User)($db)->setName($name)->create();
    }
    $f['module'] = (new ServiceModule)->connect($db)->setServiceSeq($f['service']->getSeq())->setName('module')->create();
    $f['member'] = (new ServiceMember)->connect($db)->setServiceSeq($f['service']->getSeq())->setUserSeq($f['users'][0]->getSeq())->create();
    foreach (['alpha', 'beta', 'gamma', 'delta'] as $i => $name) {
        $b = (new Battle)->connect($db)
            ->setName($name)
            ->setUserSeq($f['users'][$i % 2]->getSeq())
            ->setServiceSeq($f['service']->getSeq())
            ->setServiceModuleSeq($f['module']->getSeq())
            ->setServiceMemberSeq($f['member']->getSeq())
            ->setStartDt($start->modify("+$i hours"))
            ->setEndDt($start->modify('+48 hours'))
            ->setReadCount($i * 10)
            ->setIsClose($i % 2 === 1);
        if ($i < 2) {
            $b->setCoverUrl("cover-$name");
        }
        $f['battles'][] = $b->create();
    }
    return $f;
}

function names(Collection $c): string
{
    return implode(',', array_map(static fn(Battle $b): string => $b->getName(), $c->all()));
}

$tests = [];

$tests['conditions'] = function (Db $db, string $dsn): void {
    global $start;
    $f = seed($db);
    $svc = $f['service']->getSeq();
    $rows = (new Battle)($db)->serviceSeq($svc)->andIsClose(false)->or()->isClose(true)->orderBySeqAsc()->gets();
    check(names($rows) === 'alpha,beta,gamma,delta', 'connectors: ' . names($rows));
    $rows = (new Battle)($db)->serviceSeq($svc)
        ->and(fn(Battle $q) => $q->geReadCount(10)->andLtReadCount(30)->or()->name('alpha'))
        ->orderByReadCountDescAndSeqAsc()->gets();
    check(names($rows) === 'gamma,beta,alpha', 'group: ' . names($rows));
    $rows = (new Battle)($db)->getsBySeqAndNeName([$f['battles'][0]->getSeq(), $f['battles'][1]->getSeq()], 'beta');
    check(names($rows) === 'alpha', 'getsBy list: ' . names($rows));
    check((new Battle)($db)->coverUrl(null)->getCount() === 2, 'null');
    check((new Battle)($db)->neCoverUrl(null)->andLkName('lph')->getCount() === 1, 'not null and like');
    check((new Battle)($db)->betweenReadCount([10, 20])->getCount() === 2, 'between');
    check((new Battle)($db)->gtStartDt($start->modify('+90 minutes'))->getCount() === 2, 'time compare');
    $one = (new Battle)($db)->getByName('gamma');
    check($one !== null && $one->getReadCount() === 20, 'getBy');
    check((new Battle)($db)->getByName('missing') === null, 'get without a row');
    $q = (new Battle)($db)->serviceSeq($svc);
    check($q->getCountByIsClose(true) === 2 && $q->getCount() === 4, 'terminal changed the model');
    check((new Battle)($db)->raw('{read_count} >= ?', [20])->getCount() === 2, 'raw');
    check(code(fn() => (new Battle)($db)->name('a')->isClose(true)->gets()) === Code::CONFIG, 'missing connector');
    check(code(fn() => (new Battle)($db)->name('a')->and()->gets()) === Code::CONFIG, 'dangling connector');
    check(code(fn() => (new Battle)($db)->seq([])->gets()) === Code::EMPTY_IN, 'empty list');
    check(code(fn() => (new Battle)($db)->coverUrl(null)->andName(null)->gets()) === Code::CONFIG, 'null on a non-null column');
    check(code(fn() => (new Battle)($db)->betweenSeq([1])->gets()) === Code::CONFIG, 'between with one value');
    check(code(fn() => (new Battle)($db)->lkSeq('x')) === Code::CONFIG, 'operator not allowed');
    check(code(fn() => (new Battle)($db)->unknownColumn(1)) === Code::CONFIG, 'unknown column');
    $stmt = (new Battle)($db)->name('alpha')->getQuery();
    check(str_contains($stmt['sql'], 'name') && count($stmt['binds']) === 1, 'getQuery');
    check(code(fn() => (new Battle)->name('alpha')->gets()) === Code::CONFIG, 'no connection');
};

$tests['joins and relations'] = function (Db $db, string $dsn): void {
    global $schema;
    $f = seed($db);
    $author = (new User)->on(fn(User $u) => $u->neName('nobody'))->name('kim');
    $rows = (new Battle)($db)->leftJoinUserSeqWithSeq($author)
        ->serviceSeq($f['service']->getSeq())
        ->and(fn(Battle $q) => $q->name('delta')->or($author))
        ->orderBySeqAsc()->gets();
    check(names($rows) === 'alpha,gamma,delta', 'placed join conditions: ' . names($rows));
    check($rows->first()->getUserModel()?->getName() === 'kim', 'join result');
    $member = new ServiceMember;
    check((new Battle)($db)->joinServiceMemberSeqWithSeq($member)->readCountGtSeq($member)->getCount() === 3, 'column comparison');
    $loaded = (new Battle)($db)
        ->relation((new User)->matchUserSeqWithSeq()->aliasWriter())
        ->relations((new ServiceMember)->matchServiceSeqWithServiceSeq()->aliasMembers())
        ->relation((new ServiceModule)->matchServiceModuleSeqWithSeq())
        ->orderBySeqAsc()->gets();
    $b = $loaded->first();
    check($b->getWriter()?->getName() === 'kim', 'relation alias');
    check(count($b->getMembers()) === 1 && $b->getServiceModuleModel()->getName() === 'module', 'relations');
    $limited = (new User)($db)->relations((new Battle)->matchSeqWithUserSeq()->orderBySeqDesc()->groupLimit(1))->orderBySeqAsc()->gets();
    $got = $limited->first()->getBattleModels();
    check(count($got) === 1 && $got->first()->getName() === 'gamma', 'groupLimit');
    $other = Orm::connect($dsn, $db->config());
    $external = (new Battle)($db)->relation((new User)($other)->matchUserSeqWithSeq()->aliasOwner())->getByName('beta');
    check($external->getOwner()?->getName() === 'lee', 'relation on another connection');
    check(code(fn() => (new Battle)($db)->joinUserSeqWithSeq((new User)($db))->gets()) === Code::CONFIG, 'join child with connection');
    check(code(fn() => (new Battle)($db)->name('a')->or(new User)->gets()) === Code::CONFIG, 'unjoined model placement');
    $array = $b->toArray();
    check(($array['writer']['name'] ?? null) === 'kim' && $array['name'] === 'alpha', 'toArray');
    $json = json_decode((string) json_encode($b), true);
    check(($json['writer']['name'] ?? null) === 'kim', 'json');
};

$tests['columns and subqueries'] = function (Db $db, string $dsn): void {
    $f = seed($db);
    $users = (new User)($db)
        ->addColumnReadTotal(fn(User $u) => (new Battle)->sumReadCount()->userSeqEqSeq($u))
        ->addRawColumnDoubled('({seq} * ?)', [2])
        ->addColumnNameAliasUpperName('UPPER(%s)')
        ->seq((new Battle)->addColumnUserSeq()->isClose(false))
        ->orderBySeqAsc()->gets();
    check(count($users) === 1, 'subquery IN');
    $u = $users->first();
    check((int) $u->getReadTotal() === 20 && (int) $u->getDoubled() === 2 * $u->getSeq() && $u->getUpperName() === 'KIM', 'added columns');
    $svc = $f['service']->getSeq();
    check((new Battle)($db)->serviceSeq($svc)->sumReadCount()->getSum() === 60.0, 'sum');
    check((new Battle)($db)->serviceSeq($svc)->avgReadCount()->getAvg() === 15.0, 'avg');
    check(count((new Battle)($db)->groupByIsClose()->getsCount()) === 2, 'getsCount');
    $page = (new Battle)($db)->orderBySeqAsc()->getsPage(2, 3);
    check($page->totalCount === 4 && $page->totalPages === 2 && count($page->items) === 1 && $page->items->first()->getName() === 'delta', 'page');
    check((new Battle)($db)->keyNameName()->gets()->get('beta') !== null, 'keyName');
    foreach ([10, 11] as $a) {
        foreach ([1, 2] as $tenant) {
            (new CompositeAccount)($db)->setTenantId($tenant)->setAccountId($a)->setName('n')->create();
        }
    }
    $memberships = [
        (new CompositeMembership)->setTenantId(1)->setAccountId(10)->setRole('owner'),
        (new CompositeMembership)->setTenantId(1)->setAccountId(11)->setRole('member'),
        (new CompositeMembership)->setTenantId(2)->setAccountId(10)->setRole('member'),
    ];
    check((new CompositeMembership)($db)->creates($memberships) === 3, 'creates');
    check((new CompositeMembership)($db)->tupleTenantIdWithAccountId([[1, 10], [2, 10]])->getCount() === 2, 'tuple');
    $fetched = (new Battle)($db)->orderBySeqAsc()->fetchValue(fn(Battle $b) => strtoupper($b->getName()))->gets();
    check($fetched->fetchedValues() === ['ALPHA', 'BETA', 'GAMMA', 'DELTA'], 'fetchValue');
};

$tests['writes'] = function (Db $db, string $dsn): void {
    $f = seed($db);
    $b = (new Battle)($db)->getBySeq($f['battles'][0]->getSeq());
    $b->setName('renamed')->plusReadCount(5)->update(true);
    $again = (new Battle)($db)->getBySeq($b->getSeq());
    check($again->getName() === 'renamed' && $again->getReadCount() === 5, 'update');
    check(code(fn() => $b->setName('stale')->update(true)) === Code::CONFIG, 'optimistic update without a fresh version');
    $again->setName('again')->update();
    $b->setName('x')->update();
    $item = (new Account)($db)->setName('acc')->newLabel('shown')->create();
    check($item->getLabel() === 'shown' && $item->toArray()['label'] === 'shown', 'new value');
    check(code(fn() => (new Account)->newName('x')) === Code::CONFIG, 'new with a column name');
    $saved = (new Account)($db)->setSeq($item->getSeq())->setName('saved')->save();
    check($saved->getName() === 'saved' && (new Account)($db)->getBySeq($item->getSeq())->getName() === 'saved', 'save as update');
    (new Battle)($db)->getBySeq($f['battles'][3]->getSeq())->delete();
    check((new Battle)($db)->getCount() === 3, 'delete');
    (new Battle)($db)->isClose(true)->gets()->delete();
    check((new Battle)($db)->getCount() === 2, 'collection delete');
    (new CompositeAccount)($db)->setTenantId(9)->setAccountId(9)->setName('first')->create();
    (new CompositeAccount)($db)->setTenantId(9)->setAccountId(9)->setName('first')->duplication((new CompositeAccount)->setName('second'))->create();
    check((new CompositeAccount)($db)->getByTenantIdAndAccountId(9, 9)->getName() === 'second', 'duplication');
    $service = (new Service)($db)->setName('recursive')->create();
    (new ServiceMember)($db)->setServiceSeq($service->getSeq())->setUserSeq($f['users'][0]->getSeq())->create();
    $loaded = (new Service)($db)->relations((new ServiceMember)->matchSeqWithServiceSeq())->getBySeq($service->getSeq());
    $loaded->delete(true);
    check((new ServiceMember)($db)->getCountByServiceSeq($service->getSeq()) === 0 && (new Service)($db)->getBySeq($service->getSeq()) === null, 'delete(true)');
};

$tests['transactions'] = function (Db $db, string $dsn): void {
    $boom = new RuntimeException('boom');
    try {
        $db->transaction(function () use ($boom): void {
            (new User)->setName('rolled back')->create();
            throw $boom;
        });
        check(false, 'rollback did not throw');
    } catch (RuntimeException $e) {
        check($e === $boom, 'rollback error');
    }
    check((new User)($db)->getCount() === 0, 'rollback');
    $result = $db->transaction(function () use ($db, $boom): string {
        (new User)->setName('outer')->create();
        try {
            $db->transaction(function () use ($boom): void {
                (new User)->setName('inner')->create();
                throw $boom;
            });
        } catch (RuntimeException) {
        }
        check((new User)->getCount() === 1, 'savepoint rollback');
        (new User)->name('outer')->forUpdate()->gets();
        $db->utils()->lock('users');
        $db->utils()->setLocal('app.actor', 'tester');
        check($db->utils()->local('app.actor') === 'tester', 'local');
        check(code(fn() => $db->utils()->local('app.missing')) === Code::NO_ROWS, 'missing local');
        return 'done';
    }, isolation: 'read_committed', retry: 0);
    check($result === 'done', 'transaction result');
    check((new User)($db)->getCount() === 1, 'commit');
    check(code(fn() => (new User)($db)->forUpdate()->gets()) === Code::CONFIG, 'lock outside a transaction');
    check(code(fn() => $db->utils()->lock('x')) === Code::CONFIG, 'lock utility outside a transaction');
    $attempts = 0;
    $db->transaction(function () use (&$attempts): void {
        $attempts++;
        if ($attempts < 3) {
            throw Orm::transactionConflict('retry');
        }
    });
    check($attempts === 3, 'retry');
    check(code(fn() => $db->transaction(fn() => $db->transaction(fn() => null, readOnly: true))) === Code::CONFIG, 'nested options');
    check($db->utils()->schema()->empty() === false, 'schema empty');
    check($db->utils()->stats()->openConnections === 1, 'stats');
};

$tests['utilities'] = function (Db $db, string $dsn): void {
    $manifest = (string) file_get_contents($GLOBALS['schema']);
    $schema = $db->utils()->schema();
    check(code(fn() => $schema->install('{}')) === Code::CONFIG, 'install invalid manifest');
    $user = (new User)($db)->setName('kept')->create();
    $schema->install($manifest);
    check((new User)($db)->seq($user->getSeq())->get()?->getName() === 'kept', 'install keeps rows');
    check(code(fn() => $schema->exists('bad name')) === Code::CONFIG, 'invalid schema name');
    $privileges = $db->utils()->privileges();
    switch ($db->driver()) {
        case 'mysql':
            $name = ltrim((string) parse_url($dsn, PHP_URL_PATH), '/');
            check($schema->exists($name) && $schema->installed($name, 'user') && !$schema->installed($name, 'missing'), 'mysql schema inspection');
            check(code(fn() => $privileges->inspectTable('public.user')) === Code::CAPABILITY_UNSUPPORTED, 'mysql privileges');
            break;
        case 'postgres':
            check($schema->exists('public') && $schema->installed('public', 'user') && !$schema->installed('public', 'missing'), 'postgres schema inspection');
            $got = $privileges->inspectTable('public.user');
            check($got['select'] && $got['insert'], 'inspectTable');
            check(code(fn() => $privileges->inspectTable('user')) === Code::CONFIG, 'unqualified table');
            check(code(fn() => $privileges->revokeTable('public.user', 'drop', 'nobody')) === Code::CONFIG, 'unsupported privilege');
            break;
        default:
            check(!$schema->installed('app', 'user'), 'sqlite schema inspection');
            check(code(fn() => $privileges->grantTable('public.user', 'app')) === Code::CAPABILITY_UNSUPPORTED, 'sqlite privileges');
    }
};

$tests['deadlock retry'] =function (Db $db, string $dsn): void {
    global $schema;
    $driver = $db->driver();
    if ($driver === 'sqlite') {
        return; // one writer: two transactions cannot hold row locks at the same time
    }
    $f = seed($db);
    [$a, $b] = [$f['battles'][0]->getSeq(), $f['battles'][1]->getSeq()];
    $children = [];
    foreach ([[$a, $b, 'one'], [$b, $a, 'two']] as [$first, $second, $tag]) {
        $p = proc_open([PHP_BINARY, __DIR__ . '/deadlock_child.php', $dsn, $schema, (string) $first, (string) $second, $tag],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        $children[] = [$p, $pipes];
    }
    foreach ($children as [, $pipes]) {
        check(trim((string) fgets($pipes[1])) === 'locked', 'child did not lock its first row');
    }
    foreach ($children as [, $pipes]) {
        fwrite($pipes[0], "go\n");
        fclose($pipes[0]);
    }
    $runs = [];
    foreach ($children as [$p, $pipes]) {
        $out = trim((string) stream_get_contents($pipes[1]));
        $err = stream_get_contents($pipes[2]);
        $status = proc_close($p);
        check($status === 0 && str_starts_with($out, 'done '), "child failed ($status): $out $err");
        $runs[] = (int) substr($out, 5);
    }
    sort($runs);
    check($runs === [1, 2], 'closure runs: ' . implode(',', $runs));
};

$tests['aes rotation'] =function (Db $db, string $dsn): void {
    $f = seed($db);
    $b = (new Battle)($db)->getBySeq($f['battles'][0]->getSeq());
    $b->setAesHexEmail('person@example.com')->update();
    check((new Battle)($db)->aesHexEmail('person@example.com')->getCount() === 1, 'blind index condition');
    $keyring = new AesKeyring([1 => 'test-aes-key', 2 => 'next-aes-key'], 2);
    $status = $db->utils()->aes()->status(new Battle, $keyring);
    check($status->total === 4 && $status->pending === 4, 'status');
    check($db->utils()->aes()->rotate(new Battle, $keyring) === 4, 'rotate');
    check($db->utils()->aes()->status(new Battle, $keyring)->pending === 0, 'after rotation');
};

// Inserts and reads more values than SQLite binds in one statement: the inserts
// and the root IN list are split, duplicate IN values are read once, and a shape
// that a merge would change is rejected.
$tests['bind limit splitting'] = function (Db $db, string $dsn): void {
    $n = 1200;
    $rows = [];
    $names = [];
    for ($i = 0; $i < $n; $i++) {
        $name = sprintf('chunk-%04d', $i);
        $rows[] = (new Service)->setName($name);
        $names[] = $name;
    }
    check((new Service)($db)->creates($rows) === $n, 'inserted rows');
    $names = array_merge($names, array_slice($names, 0, 200));
    for ($i = 0; $i < 100; $i++) {
        $names[] = "missing-$i";
    }
    check(count((new Service)($db)->name($names)->gets()) === $n, 'found rows');
    check((new Service)($db)->name($names)->getCount() === $n, 'count');
    if ($db->driver() === 'sqlite') {
        check(code(fn() => (new Service)($db)->name($names)->limit(0, 10)->gets()) === Code::IR_INVALID, 'limited split');
    }
};

/**
 * Writes a wall-clock value and reads it back in the connection time zone, and
 * checks that the clock default and an equality filter use the same zone.
 */
function connectionTimeZone(Db $db, DateTimeZone $zone): void
{
    $f = seed($db);
    $midnight = new DateTimeImmutable('2026-01-02 00:00:00', $zone);
    $before = new DateTimeImmutable('now');
    $created = (new Battle)($db)
        ->setName('zone')->setUserSeq($f['users'][0]->getSeq())->setServiceSeq($f['service']->getSeq())
        ->setServiceModuleSeq($f['module']->getSeq())->setServiceMemberSeq($f['member']->getSeq())
        ->setStartDt($midnight)->setEndDt($midnight->modify('+1 day'))->create();
    $row = (new Battle)($db)->getBySeq($created->getSeq());
    check($row !== null, 'row');
    $start = $row->getStartDt();
    check($start == $midnight && $start->format('H:i') === '00:00', 'start_dt ' . $start->format(DATE_ATOM));
    $ts = $row->getCreatedTs();
    check(abs($ts->getTimestamp() - $before->getTimestamp()) < 60, 'created_ts ' . $ts->format(DATE_ATOM) . ' at ' . $before->format(DATE_ATOM));
    check($ts->getOffset() === $zone->getOffset($before), 'created_ts zone ' . $ts->format(DATE_ATOM));
    check((new Battle)($db)->startDt($midnight)->getCount() === 1, 'equality filter');
    check((new Battle)($db)->startDt('2026-01-02 00:00:00')->getCount() === 1, 'equality filter by text');
    check((new Battle)($db)->startDt('2026-01-02T00:00:00.0')->getCount() === 1, 'equality filter by text with fraction');
    check((new Battle)($db)->startDt(['2026-01-02 00:00:00', '2026-01-03 00:00:00'])->getCount() === 1, 'in filter by text');
    check((new Battle)($db)->betweenStartDt(['2026-01-02 00:00:00', '2026-01-02 00:00:00.5'])->getCount() === 1, 'between filter by text');
    if ($db->driver() === 'sqlite') {
        try {
            (new Battle)($db)->startDt('2026-01-02')->getCount();
            check(false, 'date-only datetime text');
        } catch (OrmException $e) {
            check($e->code_ === Code::CODEC_ENCODE, 'date-only datetime text: ' . $e->getMessage());
        }
    }
}

/**
 * Installs log tables and, from a second manifest, audited tables, and writes
 * inside a transaction that names its operation with setLocal; PostgreSQL and
 * SQLite use schema-qualified tables.
 */
function auditTriggers(string $driver, string $dsn): void
{
    $db = database($driver, $dsn);
    $prefix = $driver === 'mysql' ? '' : 'app.';
    $logSource = "erDiagram\n"
        . "  audit_operation {\n    bigint seq PK \"auto\"\n    varchar(36) operation_uuid UK\n  }\n"
        . "  audit_change {\n    bigint seq PK \"auto\"\n    bigint operation_seq\n    varchar(16) change_kind\n    varchar(36) site_ref \"?\"\n"
        . "    varchar(191) table_label\n    jsontext entity_ref\n    jsontext before_value\n    jsontext after_value\n  }\n"
        . ($prefix === '' ? '' : "  %% orm:table entity=audit_operation name=app.audit_operation\n  %% orm:table entity=audit_change name=app.audit_change\n");
    // The audited manifest writes into log tables that only the first manifest declares.
    $itemSource = "erDiagram\n"
        . "  audit_item {\n    bigint seq PK \"auto\"\n    varchar(36) site_ref\n    varchar(191) title\n  }\n"
        . ($prefix === '' ? '' : "  %% orm:table entity=audit_item name=app.audit_item\n")
        . "  %% orm:audit_log operation={$prefix}audit_operation(seq, operation_uuid) context=app.operation_id change={$prefix}audit_change(operation_seq, change_kind, site_ref, table_label, entity_ref, before_value, after_value)\n"
        . "  %% orm:audit entity=audit_item mode=changes site=site_ref\n";
    $table = static fn(string $name): string => match ($driver) {
        'sqlite' => "\"app__$name\"",
        'postgres' => "app.$name",
        default => $name,
    };
    $pdo = $db->pdo();
    match ($driver) {
        'postgres' => $pdo->exec('DROP SCHEMA IF EXISTS app CASCADE'),
        default => array_map(static fn(string $n) => $pdo->exec('DROP TABLE IF EXISTS ' . $table($n)), ['audit_item', 'audit_change', 'audit_operation']),
    };
    $logs = \Orm\SchemaBuilder::json(\Orm\SchemaBuilder::fromSources([$logSource]));
    $items = \Orm\SchemaBuilder::json(\Orm\SchemaBuilder::fromSources([$itemSource]));
    foreach ([$logs, $items, $items] as $manifest) {
        $db->utils()->schema()->install($manifest);
    }
    $message = '';
    try {
        $db->transaction(fn() => $db->pdo()->exec('INSERT INTO ' . $table('audit_item') . " (site_ref, title) VALUES ('s1', 'a')"), retry: 0);
    } catch (Throwable $e) {
        $message = $e->getMessage();
    }
    check(str_contains($message, 'audit operation context is required'), "write without an operation: $message");
    $db->transaction(function () use ($db, $table): void {
        $pdo = $db->pdo();
        $pdo->exec('INSERT INTO ' . $table('audit_operation') . " (operation_uuid) VALUES ('op-1')");
        $db->utils()->setLocal('app.operation_id', 'op-1');
        $pdo->exec('INSERT INTO ' . $table('audit_item') . " (site_ref, title) VALUES ('s1', 'a')");
        $pdo->exec('UPDATE ' . $table('audit_item') . " SET title = 'b'");
    }, retry: 0);
    $item = (int) $db->pdo()->query('SELECT seq FROM ' . $table('audit_item'))->fetchColumn();
    $rows = $db->pdo()->query('SELECT operation_seq, change_kind, site_ref, table_label, entity_ref, before_value, after_value FROM ' . $table('audit_change') . ' ORDER BY seq')->fetchAll(PDO::FETCH_ASSOC);
    check(array_column($rows, 'change_kind') === ['INSERT', 'UPDATE'], 'change kinds ' . json_encode(array_column($rows, 'change_kind')));
    foreach ($rows as $row) {
        check((int) $row['operation_seq'] === 1 && $row['site_ref'] === 's1' && $row['table_label'] === $prefix . 'audit_item', 'change row ' . json_encode($row));
        check(json_decode($row['entity_ref'], true) === ['seq' => $item], 'entity key ' . $row['entity_ref']);
    }
    check(json_decode($rows[1]['before_value'] ?? 'null', true) === ['title' => 'a'] && json_decode($rows[1]['after_value'] ?? 'null', true) === ['title' => 'b'], 'update values');
    match ($driver) {
        'postgres' => $pdo->exec('DROP SCHEMA IF EXISTS app CASCADE'),
        default => array_map(static fn(string $n) => $pdo->exec('DROP TABLE IF EXISTS ' . $table($n)), ['audit_item', 'audit_change', 'audit_operation']),
    };
}

foreach ($targets as $driver => $dsn) {
    $current = "pool size/$driver";
    try {
        $db = Orm::connect($dsn, new Config(schemaPath: $schema, poolSize: 3));
        check($db->utils()->stats()->maxOpenConnections === 3, 'configured pool size');
        check(code(fn() => Orm::connect($dsn, new Config(schemaPath: $schema, poolSize: -1))) === Code::CONFIG, 'negative pool size');
    } catch (Throwable $e) {
        $failures++;
        fwrite(STDERR, "FAIL $current: $e\n");
    }
    echo ($failures === 0 ? 'ok   ' : '...  ') . "$current\n";
}

foreach ($targets as $driver => $dsn) {
    $current = "statement timeout/$driver";
    try {
        check(code(fn() => Orm::connect($dsn, new Config(schemaPath: $schema, statementTimeoutMs: -1))) === Code::CONFIG, 'negative statement timeout');
        // MySQL bounds SELECT statements with max_execution_time, PostgreSQL
        // bounds every statement, and SQLite has no session timeout.
        $slow = ['mysql' => 'SLEEP(5) = 0', 'postgres' => 'pg_sleep(5) IS NULL'][$driver] ?? null;
        if ($slow !== null) {
            $db = database($driver, $dsn);
            seed($db);
            $db->close();
            $bounded = Orm::connect($dsn, new Config(schemaPath: $schema, aesKey: 'test-aes-key', blindIndexKey: 'test-blind-key', statementTimeoutMs: 200));
            // The condition is evaluated per row, so the table holds rows.
            check(code(fn() => (new Battle)($bounded)->raw($slow)->getCount()) === Code::CANCELED, 'a statement past the timeout');
            $bounded->close();
        }
    } catch (Throwable $e) {
        $failures++;
        fwrite(STDERR, "FAIL $current: $e\n");
    }
    echo ($failures === 0 ? 'ok   ' : '...  ') . "$current\n";
}

foreach ($targets as $driver => $dsn) {
    $current = "audit triggers/$driver";
    try {
        auditTriggers($driver, $dsn);
    } catch (Throwable $e) {
        $failures++;
        fwrite(STDERR, "FAIL $current: $e\n");
    }
    echo ($failures === 0 ? 'ok   ' : '...  ') . "$current\n";
}

if (isset($targets['mysql'])) {
    $current = 'install inside a transaction/mysql';
    try {
        $db = database('mysql', $targets['mysql']);
        $inside = null;
        $db->transaction(function () use ($db, $schema, &$inside): void {
            try {
                $db->utils()->schema()->install((string) file_get_contents($schema));
            } catch (OrmException $e) {
                $inside = $e;
            }
        });
        check($inside !== null && $inside->code_ === Code::CONFIG, 'install inside a transaction returns CONFIG');
    } catch (Throwable $e) {
        $failures++;
        fwrite(STDERR, "FAIL $current: $e\n");
    }
    echo ($failures === 0 ? 'ok   ' : '...  ') . "$current\n";
}

foreach ($targets as $driver => $base) {
    foreach (['+00:00', '+09:00', '-05:30', 'Asia/Seoul'] as $zoneName) {
        $current = "connection time zone $zoneName/$driver";
        try {
            $base = preg_replace('/[?&]timezone=[^&]*/', '', $base);
            $dsn = $base . (str_contains($base, '?') ? '&' : '?') . 'timezone=' . rawurlencode($zoneName);
            connectionTimeZone(database($driver, $dsn), new DateTimeZone($zoneName));
        } catch (Throwable $e) {
            $failures++;
            fwrite(STDERR, "FAIL $current: $e\n");
        }
        echo ($failures === 0 ? 'ok   ' : '...  ') . "$current\n";
    }
}

foreach ($targets as $driver => $dsn) {
    foreach ($tests as $name => $test) {
        $current = "$name/$driver";
        try {
            $db = database($driver, $dsn);
            $test($db, $dsn);
        } catch (Throwable $e) {
            $failures++;
            fwrite(STDERR, "FAIL $current: $e\n");
        }
        echo ($failures === 0 ? 'ok   ' : '...  ') . "$current\n";
    }
}
if ($failures > 0) {
    fwrite(STDERR, "php model test: $failures failures\n");
    exit(1);
}
echo "php model test: " . count($tests) . ' tests × ' . count($targets) . " databases passed\n";
