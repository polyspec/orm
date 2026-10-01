<?php
// Model integration test on SQLite, MySQL and PostgreSQL. ORM_TEST_MYSQL_DSN and
// ORM_TEST_POSTGRES_DSN name empty test databases; the test fails when either is unset.
// Usage: php clients/php/tests/model_test.php
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use Polyspec\Orm\Tests\Model\Account;
use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Tests\Model\CompositeAccount;
use Polyspec\Orm\Tests\Model\CompositeMembership;
use Polyspec\Orm\Tests\Model\Service;
use Polyspec\Orm\Tests\Model\ServiceMember;
use Polyspec\Orm\Tests\Model\ServiceRegion;
use Polyspec\Orm\Tests\Model\User;
use Orm\AesKeyring;
use Orm\Code;
use Orm\Collection;
use Orm\Config;
use Orm\Db;
use Orm\Model;
use Orm\Orm;
use Orm\OrmException;
use Orm\StyledValue;

$root = dirname(__DIR__, 3);
$documents = [(string) file_get_contents("$root/schema/bench.dbspec")];
$work = sys_get_temp_dir() . '/orm-php-model-' . getmypid();
@mkdir($work, 0o700, true);
$tables = ['account_project', 'composite_membership', 'composite_account', 'author', 'service_member', 'service_region', 'soft_record', 'account', 'project', 'user', 'service', 'task'];

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

function dropTables(string $driver, string $dsn): void
{
    global $tables;
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
}

function database(string $driver, string $dsn): Db
{
    global $documents;
    dropTables($driver, $dsn);
    $db = Orm::connect($dsn, new Config(aesKey: 'test-aes-key', blindIndexKey: 'test-blind-key'));
    $db->utils()->schema()->install($documents);
    return $db;
}

/**
 * Checks schema()->empty() on the test database without the test tables, with
 * an empty PostgreSQL schema other than public, and with the installed tables.
 */
function schemaEmpty(string $driver, string $dsn): void
{
    global $documents;
    dropTables($driver, $dsn);
    $db = Orm::connect($dsn, new Config());
    check($db->utils()->schema()->empty() === true, 'a database without tables');
    if ($driver === 'postgres') {
        $db->pdo()->exec('CREATE SCHEMA unowned_empty');
        try {
            check($db->utils()->schema()->empty() === false, 'an empty schema other than public');
        } finally {
            $db->pdo()->exec('DROP SCHEMA unowned_empty');
        }
        check($db->utils()->schema()->empty() === true, 'the empty schema dropped');
    }
    $db->utils()->schema()->install($documents);
    check($db->utils()->schema()->empty() === false, 'installed tables');
    $db->close();
}

$targets = ['sqlite' => "sqlite://$work/model.sqlite"];
foreach (['mysql' => 'ORM_TEST_MYSQL_DSN', 'postgres' => 'ORM_TEST_POSTGRES_DSN'] as $driver => $env) {
    $v = getenv($env);
    if ($v === false || $v === '') {
        throw new RuntimeException("$env is required; database tests never skip");
    }
    $targets[$driver] = $v;
}

$start = new DateTimeImmutable('2026-01-02 03:04:05', new DateTimeZone('UTC'));

/** @return array{service: Service, member: ServiceMember, module: ServiceRegion, users: list<User>, authors: list<Author>} */
function seed(Db $db): array
{
    global $start;
    $f = ['users' => [], 'authors' => []];
    $f['service'] = (new Service)->connect($db)->setName('service')->create();
    foreach (['kim', 'lee', 'park'] as $name) {
        $f['users'][] = (new User)($db)->setName($name)->create();
    }
    $f['module'] = (new ServiceRegion)->connect($db)->setServiceSeq($f['service']->getSeq())->setName('module')->create();
    $f['member'] = (new ServiceMember)->connect($db)->setServiceSeq($f['service']->getSeq())->setUserSeq($f['users'][0]->getSeq())->create();
    foreach (['alpha', 'beta', 'gamma', 'delta'] as $i => $name) {
        $b = (new Author)->connect($db)
            ->setName($name)
            ->setUserSeq($f['users'][$i % 2]->getSeq())
            ->setServiceSeq($f['service']->getSeq())
            ->setServiceRegionSeq($f['module']->getSeq())
            ->setServiceMemberSeq($f['member']->getSeq())
            ->setStartDt($start->modify("+$i hours"))
            ->setEndDt($start->modify('+48 hours'))
            ->setReadCount($i * 10)
            ->setIsClose($i % 2 === 1);
        if ($i < 2) {
            $b->setPhotoUrl("cover-$name");
        }
        $f['authors'][] = $b->create();
    }
    return $f;
}

function names(Collection $c): string
{
    return implode(',', array_map(static fn(Author $b): string => $b->getName(), $c->all()));
}

$tests = [];

$tests['conditions'] = function (Db $db, string $dsn): void {
    global $start;
    $f = seed($db);
    $svc = $f['service']->getSeq();
    $rows = (new Author)($db)->serviceSeq($svc)->andIsClose(false)->or()->isClose(true)->orderBySeqAsc()->gets();
    check(names($rows) === 'alpha,beta,gamma,delta', 'connectors: ' . names($rows));
    $rows = (new Author)($db)->serviceSeq($svc)
        ->and(fn(Author $q) => $q->geReadCount(10)->andLtReadCount(30)->or()->name('alpha'))
        ->orderByReadCountDescAndSeqAsc()->gets();
    check(names($rows) === 'gamma,beta,alpha', 'group: ' . names($rows));
    $rows = (new Author)($db)->getsBySeqAndNeName([$f['authors'][0]->getSeq(), $f['authors'][1]->getSeq()], 'beta');
    check(names($rows) === 'alpha', 'getsBy list: ' . names($rows));
    check((new Author)($db)->photoUrl(null)->getCount() === 2, 'null');
    check((new Author)($db)->nePhotoUrl(null)->andLkName('lph')->getCount() === 1, 'not null and like');
    check((new Author)($db)->betweenReadCount([10, 20])->getCount() === 2, 'between');
    check((new Author)($db)->gtStartDt($start->modify('+90 minutes'))->getCount() === 2, 'time compare');
    $one = (new Author)($db)->getByName('gamma');
    check($one !== null && $one->getReadCount() === 20, 'getBy');
    check(code(static fn() => (new Author)($db)->getByName('missing')) === 'NO_ROWS', 'get without a row');
    $q = (new Author)($db)->serviceSeq($svc);
    check($q->getCountByIsClose(true) === 2 && $q->getCount() === 4, 'terminal changed the model');
    check((new Author)($db)->raw('{read_count} >= ?', [20])->getCount() === 2, 'raw');
    check(code(fn() => (new Author)($db)->name('a')->isClose(true)->gets()) === Code::CONFIG, 'missing connector');
    check(code(fn() => (new Author)($db)->name('a')->and()->gets()) === Code::CONFIG, 'dangling connector');
    check(code(fn() => (new Author)($db)->seq([])->gets()) === Code::EMPTY_IN, 'empty list');
    check(code(fn() => (new Author)($db)->photoUrl(null)->andName(null)->gets()) === Code::CONFIG, 'null on a non-null column');
    check(code(fn() => (new Author)($db)->betweenSeq([1])->gets()) === Code::CONFIG, 'between with one value');
    check(code(fn() => (new Author)($db)->lkSeq('x')) === Code::CONFIG, 'operator not allowed');
    check(code(fn() => (new Author)($db)->unknownColumn(1)) === Code::CONFIG, 'unknown column');
    $stmt = (new Author)($db)->name('alpha')->getQuery();
    check(str_contains($stmt['sql'], 'name') && count($stmt['binds']) === 1, 'getQuery');
    check(code(fn() => (new Author)->name('alpha')->gets()) === Code::CONFIG, 'no connection');
};

$tests['joins and relations'] = function (Db $db, string $dsn): void {
    $f = seed($db);
    $author = (new User)->on(fn(User $u) => $u->neName('nobody'))->name('kim');
    $rows = (new Author)($db)->leftJoinUserSeqWithSeq($author)
        ->serviceSeq($f['service']->getSeq())
        ->and(fn(Author $q) => $q->name('delta')->or($author))
        ->orderBySeqAsc()->gets();
    check(names($rows) === 'alpha,gamma,delta', 'placed join conditions: ' . names($rows));
    check($rows->first()->getUserModel()?->getName() === 'kim', 'join result');
    $member = new ServiceMember;
    check((new Author)($db)->joinServiceMemberSeqWithSeq($member)->readCountGtSeq($member)->getCount() === 3, 'column comparison');
    $loaded = (new Author)($db)
        ->relation((new User)->matchUserSeqWithSeq()->aliasWriter())
        ->relations((new ServiceMember)->matchServiceSeqWithServiceSeq()->aliasMembers())
        ->relation((new ServiceRegion)->matchServiceRegionSeqWithSeq())
        ->orderBySeqAsc()->gets();
    $b = $loaded->first();
    check($b->getWriter()?->getName() === 'kim', 'relation alias');
    check(count($b->getMembers()) === 1 && $b->getServiceRegionModel()->getName() === 'module', 'relations');
    $limited = (new User)($db)->relations((new Author)->matchSeqWithUserSeq()->orderBySeqDesc()->groupLimit(1))->orderBySeqAsc()->gets();
    $got = $limited->first()->getAuthorModels();
    check(count($got) === 1 && $got->first()->getName() === 'gamma', 'groupLimit');
    $other = Orm::connect($dsn, $db->config());
    $external = (new Author)($db)->relation((new User)($other)->matchUserSeqWithSeq()->aliasOwner())->getByName('beta');
    check($external->getOwner()?->getName() === 'lee', 'relation on another connection');
    check(code(fn() => (new Author)($db)->joinUserSeqWithSeq((new User)($db))->gets()) === Code::CONFIG, 'join child with connection');
    check(code(fn() => (new Author)($db)->name('a')->or(new User)->gets()) === Code::CONFIG, 'unjoined model placement');
    $array = $b->toArray();
    check(($array['writer']['name'] ?? null) === 'kim' && $array['name'] === 'alpha', 'toArray');
    $json = json_decode((string) json_encode($b), true);
    check(($json['writer']['name'] ?? null) === 'kim', 'json');
};

$tests['columns and subqueries'] = function (Db $db, string $dsn): void {
    $f = seed($db);
    $users = (new User)($db)
        ->addColumnReadTotal(fn(User $u) => (new Author)->sumReadCount()->userSeqEqSeq($u))
        ->addRawColumnDoubled('({seq} * ?)', [2])
        ->addColumnNameAliasUpperName('UPPER(%s)')
        ->seq((new Author)->addColumnUserSeq()->isClose(false))
        ->orderBySeqAsc()->gets();
    check(count($users) === 1, 'subquery IN');
    $u = $users->first();
    check((int) $u->getReadTotal() === 20 && (int) $u->getDoubled() === 2 * $u->getSeq() && $u->getUpperName() === 'KIM', 'added columns');
    $svc = $f['service']->getSeq();
    check((new Author)($db)->serviceSeq($svc)->sumReadCount()->getSum() === 60.0, 'sum');
    check((new Author)($db)->serviceSeq($svc)->avgReadCount()->getAvg() === 15.0, 'avg');
    check(count((new Author)($db)->groupByIsClose()->getsCount()) === 2, 'getsCount');
    $page = (new Author)($db)->orderBySeqAsc()->getsPage(2, 3);
    check($page->totalCount === 4 && $page->totalPages === 2 && count($page->items) === 1 && $page->items->first()->getName() === 'delta', 'page');
    check((new Author)($db)->keyNameName()->gets()->get('beta') !== null, 'keyName');
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
    $fetched = (new Author)($db)->orderBySeqAsc()->fetchValue(fn(Author $b) => strtoupper($b->getName()))->gets();
    check($fetched->fetchedValues() === ['ALPHA', 'BETA', 'GAMMA', 'DELTA'], 'fetchValue');
};

$tests['writes'] = function (Db $db, string $dsn): void {
    $f = seed($db);
    $b = (new Author)($db)->getBySeq($f['authors'][0]->getSeq());
    $b->setName('renamed')->plusReadCount(5)->update(true);
    $again = (new Author)($db)->getBySeq($b->getSeq());
    check($again->getName() === 'renamed' && $again->getReadCount() === 5, 'update');
    check(code(fn() => $b->setName('stale')->update(true)) === Code::CONFIG, 'optimistic update without a fresh version');
    $again->setName('again')->update();
    $b->setName('x')->update();
    $item = (new Account)($db)->setName('acc')->newLabel('shown')->create();
    check($item->getLabel() === 'shown' && $item->toArray()['label'] === 'shown', 'new value');
    check(code(fn() => (new Account)->newName('x')) === Code::CONFIG, 'new with a column name');
    $saved = (new Account)($db)->setSeq($item->getSeq())->setName('saved')->save();
    check($saved->getName() === 'saved' && (new Account)($db)->getBySeq($item->getSeq())->getName() === 'saved', 'save as update');
    (new Author)($db)->getBySeq($f['authors'][3]->getSeq())->delete();
    check((new Author)($db)->getCount() === 3, 'delete');
    (new Author)($db)->isClose(true)->gets()->delete();
    check((new Author)($db)->getCount() === 2, 'collection delete');
    (new CompositeAccount)($db)->setTenantId(9)->setAccountId(9)->setName('first')->create();
    (new CompositeAccount)($db)->setTenantId(9)->setAccountId(9)->setName('first')->duplication((new CompositeAccount)->setName('second'))->create();
    check((new CompositeAccount)($db)->getByTenantIdAndAccountId(9, 9)->getName() === 'second', 'duplication');
    $service = (new Service)($db)->setName('recursive')->create();
    (new ServiceMember)($db)->setServiceSeq($service->getSeq())->setUserSeq($f['users'][0]->getSeq())->create();
    $loaded = (new Service)($db)->relations((new ServiceMember)->matchSeqWithServiceSeq())->getBySeq($service->getSeq());
    $loaded->delete(true);
    check((new ServiceMember)($db)->getCountByServiceSeq($service->getSeq()) === 0 && code(static fn() => (new Service)($db)->getBySeq($service->getSeq())) === 'NO_ROWS', 'delete(true)');
};

$tests['styled value states'] = function (Db $db, string $dsn): void {
    $fixture = json_decode(file_get_contents(dirname(__DIR__, 3) . '/contracts/fixtures/styled_column_states.json'), true, 512, JSON_THROW_ON_ERROR);
    $cases = array_column($fixture['cases'], null, 'id');
    $seed = seed($db);
    $seq = $seed['authors'][0]->getSeq();
    $pdo = $db->pdo();
    $pdo->beginTransaction();
    try {
        $row = (new Author)($db)->addAllColumns()->getBySeq($seq);
        check($row->getJsonSetting() instanceof StyledValue && $row->getJsonSetting()->kind === 'sql-null', 'SQL NULL getter');
        check($row->toArray()['json_setting'] === $cases['sql_null']['output'], 'SQL NULL array output');
        check(json_decode($row->toJson(), true, 512, JSON_THROW_ON_ERROR)['json_setting'] === $cases['sql_null']['output'], 'SQL NULL JSON output');
        $partial = (new Author)($db)->removeAllColumns()->addColumnName()->getBySeq($seq);
        check(code(fn() => $partial->getJsonSetting()) === Code::COLUMN_UNSELECTED, 'unselected getter');

        $row->setJsonSetting(StyledValue::value(\OrderedJson\parse('null')))
            ->setJsonsTags(StyledValue::value(\OrderedJson\parse('null')))
            ->setSerializeData(StyledValue::value(null))
            ->update();
        $loaded = (new Author)($db)->addAllColumns()->getBySeq($seq);
        check($loaded->getJsonSetting()->kind === 'value', 'JSON null getter');
        check(json_decode(Model::jsonText($loaded->toArray()['json_setting']), true, 512, JSON_THROW_ON_ERROR) === $cases['json_null']['output'], 'JSON null array output');
        check(json_decode(Model::jsonText($loaded->toArray()['jsons_tags']), true, 512, JSON_THROW_ON_ERROR) === $cases['jsons_value_null']['output'], 'JSONS null array output');
        check($loaded->toArray()['serialize_data'] === $cases['serialize_value_null']['output'], 'serialize null array output');
        $json = json_decode($loaded->toJson(), true, 512, JSON_THROW_ON_ERROR);
        check($json['json_setting'] === $cases['json_null']['output'] && $json['serialize_data'] === $cases['serialize_value_null']['output'], 'encoded null JSON output');
        $cell = $pdo->prepare('SELECT json_setting, jsons_tags, serialize_data FROM author WHERE seq = ?');
        $cell->execute([$seq]);
        $stored = $cell->fetch(\PDO::FETCH_ASSOC);
        check($stored['json_setting'] === 'null' && $stored['jsons_tags'] === 'null' && $stored['serialize_data'] === 'N;', 'encoded null storage');

        $loaded->setJsonSetting(StyledValue::value(\OrderedJson\parse('{"kind":"sql-null"}')))->update();
        $again = (new Author)($db)->addAllColumns()->getBySeq($seq);
        check(json_decode(Model::jsonText($again->toArray()['json_setting']), true, 512, JSON_THROW_ON_ERROR) === $cases['json_object_with_kind']['output'], 'JSON document does not collide with state tag');

        $again->setJsonSetting(StyledValue::sqlNull())->setJsonsTags(StyledValue::sqlNull())->setSerializeData(StyledValue::sqlNull())->update();
        $nulls = (new Author)($db)->addAllColumns()->getBySeq($seq);
        check($nulls->toArray()['json_setting'] === $cases['sql_null']['output'], 'SQL NULL restored');
        $cell = $pdo->prepare('SELECT json_setting, jsons_tags, serialize_data FROM author WHERE seq = ?');
        $cell->execute([$seq]);
        $stored = $cell->fetch(\PDO::FETCH_ASSOC);
        check($stored['json_setting'] === null && $stored['jsons_tags'] === null && $stored['serialize_data'] === null, 'SQL NULL storage');

        $pdo->prepare('UPDATE author SET json_setting = ? WHERE seq = ?')->execute(['', $seq]);
        check(code(fn() => (new Author)($db)->addAllColumns()->getBySeq($seq)) === Code::CODEC_DECODE, 'empty JSON text rejected');
    } finally {
        $pdo->rollBack();
    }
};

// ip, gz, base64 codec column은 저장한 값을 읽고, ip column은 같음으로 찾는다.
$tests['codec columns'] = function (Db $db, string $dsn): void {
    $f = seed($db);
    $seq = $f['authors'][0]->getSeq();
    (new Author)($db)->getBySeq($seq)->setIp('10.0.0.1')->setGzExtend(StyledValue::value('compressed text'))
        ->setBase64Extra(StyledValue::value('plain'))->update();
    $row = (new Author)($db)->addAllColumns()->getBySeq($seq);
    check($row->getIp() === '10.0.0.1', 'ip ' . var_export($row->getIp(), true));
    check($row->getGzExtend()->payload() === 'compressed text', 'gz styled value');
    check($row->getBase64Extra()->payload() === 'plain', 'base64 styled value');
    check((new Author)($db)->ip('10.0.0.1')->getCount() === 1, 'ip condition');
    check((new Author)($db)->addAllColumns()->getBySeq($f['authors'][1]->getSeq())->getGzExtend()->kind === 'sql-null', 'gz SQL NULL');
    $stored = $db->pdo()->query('SELECT base64_extra FROM author WHERE seq = ' . $seq)->fetchColumn();
    check($stored === base64_encode('plain'), 'base64 storage');
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
        $db->utils()->setLocal('ormtest.actor', 'tester');
        check($db->utils()->local('ormtest.actor') === 'tester', 'local');
        check(code(fn() => $db->utils()->local('ormtest.missing')) === Code::NO_ROWS, 'missing local');
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
    $documents = $GLOBALS['documents'];
    $schema = $db->utils()->schema();
    check(code(fn() => $schema->install(["dbspec 1 broken\n\ntable t {\n}\n"])) === Code::SCHEMA_INVALID, 'install an invalid document');
    $user = (new User)($db)->setName('kept')->create();
    $schema->install($documents);
    check((new User)($db)->seq($user->getSeq())->get()?->getName() === 'kept', 'install again keeps rows');
    $db->pdo()->exec($db->driver() === 'postgres' ? 'DROP TABLE "task" CASCADE' : ($db->driver() === 'mysql' ? 'DROP TABLE `task`' : 'DROP TABLE "task"'));
    check(code(fn() => $schema->install($documents)) === Code::CONFIG, 'install over some tables of the set');
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
            check(!$schema->installed('ormexample', 'user'), 'sqlite schema inspection');
            check(code(fn() => $privileges->grantTable('public.user', 'orm')) === Code::CAPABILITY_UNSUPPORTED, 'sqlite privileges');
    }
};

$tests['deadlock retry'] =function (Db $db, string $dsn): void {
    $driver = $db->driver();
    if ($driver === 'sqlite') {
        return; // one writer: two transactions cannot hold row locks at the same time
    }
    $f = seed($db);
    [$a, $b] = [$f['authors'][0]->getSeq(), $f['authors'][1]->getSeq()];
    $children = [];
    foreach ([[$a, $b, 'one'], [$b, $a, 'two']] as [$first, $second, $tag]) {
        $p = proc_open([PHP_BINARY, __DIR__ . '/deadlock_child.php', $dsn, (string) $first, (string) $second, $tag],
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
    $b = (new Author)($db)->getBySeq($f['authors'][0]->getSeq());
    $b->setAesHexEmail('person@example.com')->update();
    check((new Author)($db)->aesHexEmail('person@example.com')->getCount() === 1, 'blind index condition');
    $keyring = new AesKeyring([1 => 'test-aes-key', 2 => 'next-aes-key'], 2);
    $status = $db->utils()->aes()->status(new Author, $keyring);
    check($status->total === 4 && $status->pending === 4, 'status');
    check($db->utils()->aes()->rotate(new Author, $keyring) === 4, 'rotate');
    check($db->utils()->aes()->status(new Author, $keyring)->pending === 0, 'after rotation');
    global $schema;
    // A write with only aesKeys and aesVersion encrypts with aesKeys[aesVersion].
    $versioned = Orm::connect($dsn, new Config(blindIndexKey: 'test-blind-key', aesVersion: 2, aesKeys: [1 => 'test-aes-key', 2 => 'next-aes-key']));
    (new Author)($versioned)->getBySeq($f['authors'][1]->getSeq())->setAesHexEmail('second@example.com')->update();
    $current = Orm::connect($dsn, new Config(blindIndexKey: 'test-blind-key', aesVersion: 2, aesKeys: [2 => 'next-aes-key']));
    check((new Author)($current)->getBySeq($f['authors'][1]->getSeq())->getAesHexEmail() === 'second@example.com', 'write with the key of aesVersion');
    check(code(fn() => new Config(aesKey: 'other-key', aesKeys: [1 => 'test-aes-key'])) === Code::CONFIG, 'aesKey differs from aesKeys[aesVersion]');
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
 * 다른 zone의 값을 UTC wall clock으로 쓰고 UTC로 읽으며, clock default와
 * text 같음 filter가 같은 UTC 규칙을 쓰는지 확인한다.
 */
function connectionUtc(Db $db): void
{
    $f = seed($db);
    $midnight = new DateTimeImmutable('2026-01-02 09:00:00', new DateTimeZone('+09:00'));
    $before = new DateTimeImmutable('now');
    $created = (new Author)($db)
        ->setName('zone')->setUserSeq($f['users'][0]->getSeq())->setServiceSeq($f['service']->getSeq())
        ->setServiceRegionSeq($f['module']->getSeq())->setServiceMemberSeq($f['member']->getSeq())
        ->setStartDt($midnight)->setEndDt($midnight->modify('+1 day'))->create();
    $row = (new Author)($db)->getBySeq($created->getSeq());
    check($row !== null, 'row');
    $start = $row->getStartDt();
    check($start == $midnight && $start->format('H:i P') === '00:00 +00:00', 'start_dt ' . $start->format(DATE_ATOM));
    $ts = $row->getCreatedTs();
    check(abs($ts->getTimestamp() - $before->getTimestamp()) < 60, 'created_ts ' . $ts->format(DATE_ATOM) . ' at ' . $before->format(DATE_ATOM));
    check($ts->getOffset() === 0, 'created_ts zone ' . $ts->format(DATE_ATOM));
    check((new Author)($db)->startDt($midnight)->getCount() === 1, 'equality filter');
    check((new Author)($db)->startDt('2026-01-02 00:00:00')->getCount() === 1, 'equality filter by text');
    check((new Author)($db)->startDt('2026-01-02T00:00:00.0')->getCount() === 1, 'equality filter by text with fraction');
    check((new Author)($db)->startDt(['2026-01-02 00:00:00', '2026-01-03 00:00:00'])->getCount() === 1, 'in filter by text');
    check((new Author)($db)->betweenStartDt(['2026-01-02 00:00:00', '2026-01-02 00:00:00.5'])->getCount() === 1, 'between filter by text');
    if ($db->driver() === 'sqlite') {
        try {
            (new Author)($db)->startDt('2026-01-02')->getCount();
            check(false, 'date-only datetime text');
        } catch (OrmException $e) {
            check($e->code_ === Code::CODEC_ENCODE, 'date-only datetime text: ' . $e->getMessage());
        }
    }
}

foreach ($targets as $driver => $dsn) {
    $current = "schema empty/$driver";
    try {
        schemaEmpty($driver, $dsn);
    } catch (Throwable $e) {
        $failures++;
        fwrite(STDERR, "FAIL $current: $e\n");
    }
    echo ($failures === 0 ? 'ok   ' : '...  ') . "$current\n";
}

foreach ($targets as $driver => $dsn) {
    $current = "pool size/$driver";
    try {
        $db = Orm::connect($dsn, new Config(poolSize: 3));
        check($db->utils()->stats()->maxOpenConnections === 3, 'configured pool size');
        check(code(fn() => Orm::connect($dsn, new Config(poolSize: -1))) === Code::CONFIG, 'negative pool size');
        // The PHP client has no pool, so the pool idle size and lifetime are rejected.
        check(code(fn() => Orm::connect($dsn, new Config(poolIdleSize: 1))) === Code::CONFIG, 'pool idle size');
        check(code(fn() => Orm::connect($dsn, new Config(poolLifetimeMs: 1000))) === Code::CONFIG, 'pool lifetime');
    } catch (Throwable $e) {
        $failures++;
        fwrite(STDERR, "FAIL $current: $e\n");
    }
    echo ($failures === 0 ? 'ok   ' : '...  ') . "$current\n";
}

foreach ($targets as $driver => $dsn) {
    $current = "statement timeout/$driver";
    try {
        check(code(fn() => Orm::connect($dsn, new Config(statementTimeoutMs: -1))) === Code::CONFIG, 'negative statement timeout');
        // MySQL bounds SELECT statements with max_execution_time, PostgreSQL
        // bounds every statement, and SQLite has no session timeout.
        $slow = ['mysql' => 'SLEEP(5) = 0', 'postgres' => 'pg_sleep(5) IS NULL'][$driver] ?? null;
        if ($slow !== null) {
            $db = database($driver, $dsn);
            seed($db);
            $db->close();
            $bounded = Orm::connect($dsn, new Config(aesKey: 'test-aes-key', blindIndexKey: 'test-blind-key', statementTimeoutMs: 200));
            // The condition is evaluated per row, so the table holds rows.
            check(code(fn() => (new Author)($bounded)->raw($slow)->getCount()) === Code::CANCELED, 'a statement past the timeout');
            $bounded->close();
        }
    } catch (Throwable $e) {
        $failures++;
        fwrite(STDERR, "FAIL $current: $e\n");
    }
    echo ($failures === 0 ? 'ok   ' : '...  ') . "$current\n";
}

// A pooler in transaction mode hands one server session to every client in
// turn. Through ORM_TEST_PGBOUNCER_SINGLE_DSN every client shares one server
// connection, so the statement timeout of one connection must bound only the
// statements of that connection.
$current = 'statement timeout through a pooler/postgres';
try {
    $single = getenv('ORM_TEST_PGBOUNCER_SINGLE_DSN');
    if ($single === false || $single === '') {
        throw new RuntimeException('ORM_TEST_PGBOUNCER_SINGLE_DSN is required; database tests never skip');
    }
    $db = database('postgres', $targets['postgres']);
    seed($db);
    $db->close();
    // Four rows sleep 0.1 s each, so the statement runs past 200 ms.
    $slow = 'pg_sleep(0.1) IS NOT NULL';
    $bounded = Orm::connect($single, new Config(statementTimeoutMs: 200));
    check(code(fn() => (new Author)($bounded)->raw($slow)->getCount()) === Code::CANCELED, 'the bounded connection through the pooler');
    $plain = Orm::connect($single, new Config());
    check((new Author)($plain)->raw($slow)->getCount() === 4, 'a connection without a timeout after the bounded one');
    check(code(fn() => (new Author)($bounded)->raw($slow)->getCount()) === Code::CANCELED, 'the bounded connection after the plain one');
    $bounded->close();
    $plain->close();
} catch (Throwable $e) {
    $failures++;
    fwrite(STDERR, "FAIL $current: $e\n");
}
echo ($failures === 0 ? 'ok   ' : '...  ') . "$current\n";

if (isset($targets['mysql'])) {
    $current = 'install inside a transaction/mysql';
    try {
        $db = database('mysql', $targets['mysql']);
        $inside = null;
        $db->transaction(function () use ($db, $documents, &$inside): void {
            try {
                $db->utils()->schema()->install($documents);
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
    foreach (['', '+00:00', 'UTC', '+09:00', 'Asia/Seoul'] as $zoneName) {
        $current = "connection time zone $zoneName/$driver";
        try {
            $base = preg_replace('/[?&]timezone=[^&]*/', '', $base);
            $dsn = $zoneName === '' ? $base : $base . (str_contains($base, '?') ? '&' : '?') . 'timezone=' . rawurlencode($zoneName);
            if (in_array($zoneName, ['', '+00:00', 'UTC'], true)) {
                connectionUtc(database($driver, $dsn));
            } else {
                check(code(fn() => Orm::connect($dsn, new Config())) === Code::CONFIG, 'a time zone other than UTC');
            }
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
/**
 * Returns after the replica has applied every change the primary committed
 * before the call. On PostgreSQL a transaction with
 * synchronous_commit=remote_apply that writes WAL, here a transactional
 * logical message, commits after the standby has applied it; a transaction
 * that writes no WAL besides its commit record does not wait. On MySQL
 * SOURCE_POS_WAIT on the replica waits for the binary log position of the
 * primary.
 */
function awaitReplica(string $driver, string $primary, string $replica): void
{
    [, $pdoDsn, $user, $password] = Orm::parseDsn($primary);
    $source = new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    if ($driver === 'postgres') {
        $source->beginTransaction();
        $source->exec('SET LOCAL synchronous_commit = remote_apply');
        $mode = $source->query("SELECT current_setting('synchronous_commit'), pg_logical_emit_message(true, 'orm-test-barrier', '')")->fetchColumn();
        if ($mode !== 'remote_apply') {
            throw new RuntimeException("synchronous_commit of the barrier transaction is $mode");
        }
        $source->commit();
        return;
    }
    $status = $source->query('SHOW BINARY LOG STATUS')->fetch(PDO::FETCH_NUM);
    [, $pdoDsn, $user, $password] = Orm::parseDsn($replica);
    $target = new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $st = $target->prepare('SELECT SOURCE_POS_WAIT(?, ?, 10)');
    $st->execute([$status[0], (int) $status[1]]);
    $waited = $st->fetchColumn();
    if ($waited === null || (int) $waited < 0) {
        throw new RuntimeException("the replica did not reach {$status[0]}:{$status[1]}");
    }
}

// A connection to the primary and one to its replica work side by side. A
// model uses the connection it is connected to and no other, and a model
// without a connection inside a transaction uses the transaction.
foreach (['mysql' => 'MYSQL', 'postgres' => 'POSTGRES'] as $driver => $env) {
    $current = "primary and replica/$driver";
    try {
        $replica = getenv("ORM_TEST_{$env}_REPLICA_DSN");
        if ($replica === false || $replica === '') {
            throw new RuntimeException("ORM_TEST_{$env}_REPLICA_DSN is required; database tests never skip");
        }
        $master = database($driver, $targets[$driver]);
        $name = 'replica-' . hrtime(true);
        (new User)($master)->setName($name)->create();
        awaitReplica($driver, $targets[$driver], $replica);
        $slave1 = Orm::connect($replica, new Config(aesKey: 'test-aes-key', blindIndexKey: 'test-blind-key'));
        check((new User)($slave1)->name($name)->getCount() === 1, 'the replica reads the row written through the primary');
        check(code(fn() => (new User)($slave1)->setName("$name-replica")->create()) === Code::READ_ONLY, 'a write through the replica connection is rejected');
        check((new User)($master)->name("$name-replica")->getCount() === 0, 'a write through the replica connection does not reach the primary');
        // A row read through the replica is written through the primary.
        (new User)($slave1)->name($name)->get()->connect($master)->setName("$name-renamed")->update();
        $master->transaction(function () use ($master, $slave1, $name): void {
            (new User)->setName("$name-tx")->create();
            check((new User)($master)->name("$name-tx")->getCount() === 1, 'the primary connection inside its transaction');
            check((new User)($slave1)->name("$name-tx")->getCount() === 0, 'the replica connection reads no uncommitted row');
        });
        awaitReplica($driver, $targets[$driver], $replica);
        check((new User)($slave1)->name(["$name-renamed", "$name-tx"])->getCount() === 2, 'the replica reads the committed rows');
        $slave1->close();
        $master->close();
    } catch (Throwable $e) {
        $failures++;
        fwrite(STDERR, "FAIL $current: $e\n");
    }
    echo ($failures === 0 ? 'ok   ' : '...  ') . "$current\n";
}

// A connection to a SQLite database file that the process may only read:
// SQLite opens it read-only, reads succeed, and a write returns READ_ONLY.
$current = 'read-only/sqlite';
try {
    $path = "$work/read-only.sqlite";
    $writable = database('sqlite', "sqlite://$path");
    (new User)($writable)->setName('read-only')->create();
    $writable->close();
    chmod($path, 0o444);
    $readOnly = Orm::connect("sqlite://$path", new Config(aesKey: 'test-aes-key', blindIndexKey: 'test-blind-key'));
    check((new User)($readOnly)->name('read-only')->getCount() === 1, 'the read-only database reads the row');
    check(code(fn() => (new User)($readOnly)->setName('rejected')->create()) === Code::READ_ONLY, 'a write to the read-only database');
    $readOnly->close();
} catch (Throwable $e) {
    $failures++;
    fwrite(STDERR, "FAIL $current: $e\n");
}
echo ($failures === 0 ? 'ok   ' : '...  ') . "$current\n";

// 실제 server 는 transaction 끝의 cleanup statement 와 rollback 을 거부하지 않으므로
// PDO 가 rejects 가 고른 statement 와, rejectRollback 이면 rollback 을 실패시킨다.
// rollback 은 실제로 끝낸 뒤 실패를 돌려준다.
final class FailingPdo extends PDO
{
    /** @var ?Closure(string): bool */
    public ?Closure $rejects = null;
    public bool $rejectRollback = false;

    private function check(string $statement): void
    {
        if ($this->rejects !== null && ($this->rejects)($statement)) {
            throw new PDOException('statement rejected by the test driver');
        }
    }

    public function exec(string $statement): int|false
    {
        $this->check($statement);
        return parent::exec($statement);
    }

    public function prepare(string $query, array $options = []): PDOStatement|false
    {
        $this->check($query);
        return parent::prepare($query, $options);
    }

    public function rollBack(): bool
    {
        $ok = parent::rollBack();
        if ($this->rejectRollback) {
            throw new PDOException('rollback rejected by the test driver');
        }
        return $ok;
    }
}

/** fn 이 던진 오류의 message 다. 오류가 없으면 'no error' 다. */
function failureMessage(callable $fn): string
{
    try {
        $fn();
    } catch (Throwable $e) {
        return $e->getMessage();
    }
    return 'no error';
}

/** message 가 callback 오류와 transaction 끝의 오류를 함께 담은 CONFIG 인지 확인한다. */
function checkBoth(string $what, string $message, string $cause, string $end): void
{
    check(str_starts_with($message, "CONFIG: transaction failed ($cause) and rollback failed (") && str_contains($message, $end), "$what reports the cause and the failed transaction end: $message");
}

// transaction 끝의 MySQL local 값 reset 이 실패하면 commit 과 rollback 이 그 오류를
// 보고한다. MySQL user variable 은 COMMIT 과 ROLLBACK 뒤에도 남는다
// (mysql.context.user_variable_session_scope).
$current = 'failed local reset/mysql';
try {
    [, $pdoDsn, $user, $password] = Orm::parseDsn($targets['mysql']);
    $pdo = new FailingPdo($pdoDsn, $user, $password);
    $pdo->rejects = static fn(string $sql): bool => str_starts_with($sql, 'SET @`orm.') && str_ends_with($sql, '= NULL');
    $failing = new Db($pdo, 'mysql', new Config(), new DateTimeZone('UTC'));
    $committed = failureMessage(fn() => $failing->transaction(function () use ($failing): void {
        $failing->utils()->setLocal('ormtest.actor', 'tester');
    }));
    check(str_contains($committed, 'statement rejected by the test driver'), "commit reports the failed reset: $committed");
    $rolledBack = failureMessage(fn() => $failing->transaction(function () use ($failing): void {
        $failing->utils()->setLocal('ormtest.actor', 'tester');
        throw new RuntimeException('callback failed');
    }));
    checkBoth('rollback', $rolledBack, 'callback failed', 'statement rejected by the test driver');
} catch (Throwable $e) {
    $failures++;
    fwrite(STDERR, "FAIL $current: $e\n");
}
echo ($failures === 0 ? 'ok   ' : '...  ') . "$current\n";

// transaction 끝의 MySQL RELEASE_LOCK 이 실패하거나 lock 을 풀지 못하면 commit 과
// rollback 이 그 오류를 보고한다. 풀리지 않은 named lock 은 connection 에 남는다.
$current = 'failed lock release/mysql';
try {
    [, $pdoDsn, $user, $password] = Orm::parseDsn($targets['mysql']);
    $pdo = new FailingPdo($pdoDsn, $user, $password);
    $failing = new Db($pdo, 'mysql', new Config(), new DateTimeZone('UTC'));
    $key = static fn(string $name): string => "orm_test.$name." . getmypid();
    $pdo->rejects = static fn(string $sql): bool => str_starts_with($sql, 'SELECT RELEASE_LOCK');
    $committed = failureMessage(fn() => $failing->transaction(function () use ($failing, $key): void {
        $failing->utils()->lock($key('commit'));
    }, retry: 0));
    check(str_contains($committed, 'statement rejected by the test driver'), "commit reports the failed release: $committed");
    $rolledBack = failureMessage(fn() => $failing->transaction(function () use ($failing, $key): void {
        $failing->utils()->lock($key('rollback'));
        throw new RuntimeException('callback failed');
    }, retry: 0));
    checkBoth('rollback', $rolledBack, 'callback failed', 'statement rejected by the test driver');
    $pdo->rejects = null;
    // lock 을 미리 풀면 transaction 끝의 RELEASE_LOCK 은 0 을 돌려준다.
    $notHeld = failureMessage(fn() => $failing->transaction(function () use ($failing, $pdo, $key): void {
        $failing->utils()->lock($key('released'));
        $pdo->prepare('DO RELEASE_LOCK(?)')->execute([$key('released')]);
    }, retry: 0));
    check(str_contains($notHeld, 'lock ' . $key('released') . ' was not held at transaction end'), "a lock released early is reported: $notHeld");
} catch (Throwable $e) {
    $failures++;
    fwrite(STDERR, "FAIL $current: $e\n");
}
echo ($failures === 0 ? 'ok   ' : '...  ') . "$current\n";

// native rollback, SQLite mode 복원, begin 뒤의 rollback 이 실패하면 transaction 이
// 그 오류를 원인과 함께 보고한다.
$current = 'failed rollback/sqlite';
try {
    $pdo = new FailingPdo("sqlite:$work/transaction-end.sqlite");
    $failing = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));
    $pdo->rejectRollback = true;
    $rolledBack = failureMessage(fn() => $failing->transaction(function (): void {
        throw new RuntimeException('callback failed');
    }, retry: 0));
    checkBoth('rollback', $rolledBack, 'callback failed', 'rollback rejected by the test driver');
    $pdo->rejects = static fn(string $sql): bool => $sql === 'PRAGMA query_only = 1';
    $began = failureMessage(fn() => $failing->transaction(fn() => null, readOnly: true, retry: 0));
    checkBoth('begin', $began, 'statement rejected by the test driver', 'rollback rejected by the test driver');
    $pdo->rejectRollback = false;
    $pdo->rejects = static fn(string $sql): bool => $sql === 'PRAGMA query_only = 0';
    $committed = failureMessage(fn() => $failing->transaction(fn() => null, readOnly: true, retry: 0));
    check(str_contains($committed, 'statement rejected by the test driver'), "commit reports the failed mode reset: $committed");
    $rolledBack = failureMessage(fn() => $failing->transaction(function (): void {
        throw new RuntimeException('callback failed');
    }, readOnly: true, retry: 0));
    checkBoth('mode reset', $rolledBack, 'callback failed', 'statement rejected by the test driver');
} catch (Throwable $e) {
    $failures++;
    fwrite(STDERR, "FAIL $current: $e\n");
}
echo ($failures === 0 ? 'ok   ' : '...  ') . "$current\n";

if ($failures > 0) {
    fwrite(STDERR, "php model test: $failures failures\n");
    exit(1);
}
echo "php model test: " . count($tests) . ' tests × ' . count($targets) . " databases passed\n";
