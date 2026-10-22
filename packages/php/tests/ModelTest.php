<?php

declare(strict_types=1);

// Model integration test on SQLite, MySQL and PostgreSQL. A case that installs
// the schema runs in a case database of its own (case_database.php) created
// through ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN; the cases that only
// connect use those databases and create nothing there. The test fails when
// either is unset.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/ModelTest.php
// [--filter <case>]

use Polyspec\Orm\Tests\Model\Account;
use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Tests\Model\CompositeAccount;
use Polyspec\Orm\Tests\Model\CompositeMembership;
use Polyspec\Orm\Tests\Model\Service;
use Polyspec\Orm\Tests\Model\ServiceMember;
use Polyspec\Orm\Tests\Model\ServiceRegion;
use Polyspec\Orm\Tests\Model\User;
use Polyspec\Orm\AesKeyring;
use Polyspec\Orm\Code;
use Polyspec\Orm\Collection;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Generator;
use Polyspec\Orm\Model;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\StyledValue;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\DataProvider;

#[Medium]
final class ModelTest extends TestCase
{
    private static mixed $work = null;
    private static mixed $targets = null;
    private static mixed $root = null;
    private static mixed $documents = null;
    private static mixed $start = null;
    private static mixed $caseDatabases = null;
    private static mixed $schema = null;

    /** The fixture of the file: what the script did before its cases, once per class. */
    private static function fixture(): void
    {
        self::$root = dirname(__DIR__, 3);
        self::$documents = [(string) file_get_contents(self::$root . "/contracts/fixtures/bench/bench.dbs")];
        self::$work = sys_get_temp_dir() . '/orm-php-model-' . getmypid();
        is_dir(self::$work) || mkdir(self::$work, 0o700, true);

        self::$caseDatabases = [];

        register_shutdown_function(static function (): void {
            exec('rm -rf ' . escapeshellarg(self::$work));
        });

        // A shared test database. The cases that only connect, without installing a schema, use it, and nothing is
        // created in that database. A case that installs a schema gets its own case database from caseDsn().
        self::$targets = ['sqlite' => "sqlite://" . self::$work . "/model.sqlite"];
        foreach (['mysql' => 'ORM_TEST_MYSQL_DSN', 'postgres' => 'ORM_TEST_POSTGRES_DSN'] as $driver => $env) {
            $v = requiredDsn($env);
            if ($v === false || $v === '') {
                throw new RuntimeException(
                    "$env is required; database tests never skip; run the test through its make target, which reads "
                    . "the environment of make orm-test-servers"
                );
            }
            self::$targets[$driver] = $v;
        }

        self::$start = new DateTimeImmutable('2026-01-02 03:04:05', new DateTimeZone('UTC'));
    }

    /** The case database of the open case. tearDown removes it even if the case failed. */
    private static function caseDatabase(string $driver): CaseDatabase
    {
        $database = case_database($driver, static function (string $step): void {
        });
        self::$caseDatabases[] = $database;
        return $database;
    }

    private static function caseDsn(string $driver): string
    {
        return self::caseDatabase($driver)->dsn;
    }

    private static function check(bool $ok, string $message): void
    {
        \PHPUnit\Framework\Assert::assertTrue($ok, $message);
    }

    private static function code(callable $fn): string
    {
        try {
            $fn();
        } catch (OrmException $e) {
            return $e->code_;
        }
        return 'no error';
    }

    /** The connection with the bench schema installed in the database of $dsn (the case database). */
    private static function database(string $driver, string $dsn): Db
    {
        $db = \Polyspec\Orm\Tests\Model\connect(
            $dsn,
            new Config(aesKey: 'test-aes-key', blindIndexKey: 'test-blind-key')
        );
        \Polyspec\Orm\Tests\installBench($db);
        return $db;
    }

    /**
     * Checks schema()->empty() on a new case database, with an empty PostgreSQL
     * schema other than public, and with the installed tables.
     */
    private static function schemaEmpty(string $driver, string $dsn): void
    {
        $db = \Polyspec\Orm\Tests\Model\connect($dsn, new Config());
        self::check($db->utils()->schema()->empty() === true, 'a database without tables');
        if ($driver === 'postgres') {
            $db->pdo()->exec('CREATE SCHEMA unowned_empty');
            try {
                self::check($db->utils()->schema()->empty() === false, 'an empty schema other than public');
            } finally {
                $db->pdo()->exec('DROP SCHEMA unowned_empty');
            }
            self::check($db->utils()->schema()->empty() === true, 'the empty schema dropped');
        }
        \Polyspec\Orm\Tests\installBench($db);
        self::check($db->utils()->schema()->empty() === false, 'installed tables');
        $db->close();
    }

    /**
     * @return array{service: Service, member: ServiceMember, module: ServiceRegion, users: list<User>, authors:
     *   list<Author>}
     */
    private static function seed(Db $db): array
    {
        $f = ['users' => [], 'authors' => []];
        $f['service'] = (new Service())->connect($db)->setName('service')->create();
        foreach (['kim', 'lee', 'park'] as $name) {
            $f['users'][] = (new User())($db)->setName($name)->create();
        }
        $f['module'] = (new ServiceRegion())->connect($db)
            ->setServiceSeq($f['service']->getSeq())
            ->setName('module')
            ->create();
        $f['member'] = (new ServiceMember())->connect($db)
            ->setServiceSeq($f['service']->getSeq())
            ->setUserSeq($f['users'][0]->getSeq())
            ->create();
        foreach (['alpha', 'beta', 'gamma', 'delta'] as $i => $name) {
            $b = (new Author())->connect($db)
                ->setName($name)
                ->setUserSeq($f['users'][$i % 2]->getSeq())
                ->setServiceSeq($f['service']->getSeq())
                ->setServiceRegionSeq($f['module']->getSeq())
                ->setServiceMemberSeq($f['member']->getSeq())
                ->setStartDt(self::$start->modify("+$i hours")->format('Y-m-d H:i:s'))
                ->setEndDt(self::$start->modify('+48 hours')->format('Y-m-d H:i:s'))
                ->setReadCount($i * 10)
                ->setIsClose($i % 2 === 1);
            if ($i < 2) {
                $b->setPhotoUrl("cover-$name");
            }
            $f['authors'][] = $b->create();
        }
        return $f;
    }

    private static function names(Collection $c): string
    {
        return implode(',', array_map(static fn(Author $b): string => $b->getName(), $c->all()));
    }

    private static function caseConditions(Db $db, string $dsn): void
    {
        $f = self::seed($db);
        $svc = $f['service']->getSeq();
        $rows = (new Author())($db)->serviceSeq($svc)->andIsClose(false)->or()->isClose(true)->orderBySeqAsc()->gets();
        self::check(self::names($rows) === 'alpha,beta,gamma,delta', 'connectors: ' . self::names($rows));
        $rows = (new Author())($db)->serviceSeq($svc)
            ->and(fn(Author $q) => $q->geReadCount(10)->andLtReadCount(30)->or()->name('alpha'))
            ->orderByReadCountDescAndSeqAsc()->gets();
        self::check(self::names($rows) === 'gamma,beta,alpha', 'group: ' . self::names($rows));
        $rows = (new Author())($db)->getsBySeqAndNeName(
            [$f['authors'][0]->getSeq(), $f['authors'][1]->getSeq()],
            'beta'
        );
        self::check(self::names($rows) === 'alpha', 'getsBy list: ' . self::names($rows));
        self::check((new Author())($db)->photoUrl(null)->getCount() === 2, 'null');
        self::check((new Author())($db)->nePhotoUrl(null)->andLkName('lph')->getCount() === 1, 'not null and like');
        self::check((new Author())($db)->betweenReadCount([10, 20])->getCount() === 2, 'between');
        self::check(
            (new Author())($db)->gtStartDt(
                self::$start->modify('+90 minutes')->format('Y-m-d H:i:s')
            )->getCount() === 2,
            'time compare'
        );
        $one = (new Author())($db)->getByName('gamma');
        self::check($one !== null && $one->getReadCount() === 20, 'getBy');
        self::check((new Author())($db)->getByName('missing') === null, 'get without a row');
        $q = (new Author())($db)->serviceSeq($svc);
        self::check($q->getCountByIsClose(true) === 2 && $q->getCount() === 4, 'terminal changed the model');
        self::check((new Author())($db)->geReadCount(20)->getCount() === 2, 'ge');
        self::check(
            self::code(fn() => (new Author())($db)->name('a')->isClose(true)->gets()) === Code::CONFIG,
            'missing connector'
        );
        self::check(
            self::code(fn() => (new Author())($db)->name('a')->and()->gets()) === Code::CONFIG,
            'dangling connector'
        );
        self::check(self::code(fn() => (new Author())($db)->seq([])->gets()) === Code::EMPTY_IN, 'empty list');
        // The test of DSL-49 (null only for a nullable column) and DSL-50 (a list and null only without an operator,
        // with Eq and with Ne) (docs/spec/dsl.md).
        self::check(
            self::code(fn() => (new Author())($db)->photoUrl(null)->andName(null)->gets()) === Code::CONFIG,
            'null on a non-null column'
        );
        self::check(
            self::code(fn() => (new Author())($db)->gtReadCount([10, 20])->gets()) === Code::CONFIG,
            'a list with an operator'
        );
        self::check(
            self::code(fn() => (new Author())($db)->gtReadCount(null)->gets()) === Code::CONFIG,
            'null with an operator'
        );
        self::check(
            (new Author())($db)->neReadCount([10, 20])->andServiceSeq($svc)->getCount() === 2,
            'a list with Ne'
        );
        self::check(
            self::code(fn() => (new Author())($db)->betweenSeq([1])->gets()) === Code::CONFIG,
            'between with one value'
        );
        self::check(self::code(fn() => (new Author())($db)->lkSeq('x')) === Code::CONFIG, 'operator not allowed');
        self::check(self::code(fn() => (new Author())($db)->unknownColumn(1)) === Code::CONFIG, 'unknown column');
        $stmt = (new Author())($db)->name('alpha')->getQuery();
        self::check(str_contains($stmt['sql'], 'name') && count($stmt['binds']) === 1, 'getQuery');
        self::check(self::code(fn() => (new Author())->name('alpha')->gets()) === Code::CONFIG, 'no connection');
    }

    private static function caseJoinsAndRelations(Db $db, string $dsn): void
    {
        $f = self::seed($db);
        $author = (new User())->on(fn(User $u) => $u->neName('nobody'))->name('kim');
        $rows = (new Author())($db)->leftJoinUserSeqWithSeq($author)
            ->serviceSeq($f['service']->getSeq())
            ->and(fn(Author $q) => $q->name('delta')->or($author))
            ->orderBySeqAsc()->gets();
        self::check(self::names($rows) === 'alpha,gamma,delta', 'placed join conditions: ' . self::names($rows));
        self::check($rows->first()->getUserModel()?->getName() === 'kim', 'join result');
        $member = new ServiceMember();
        self::check(
            (new Author())($db)->joinServiceMemberSeqWithSeq($member)->readCountGtSeq($member)->getCount() === 3,
            'column comparison'
        );
        $loaded = (new Author())($db)
            ->relation((new User())->matchUserSeqWithSeq()->aliasWriter())
            ->relations((new ServiceMember())->matchServiceSeqWithServiceSeq()->aliasMembers())
            ->relation((new ServiceRegion())->matchServiceRegionSeqWithSeq())
            ->orderBySeqAsc()->gets();
        $b = $loaded->first();
        self::check($b->getWriter()?->getName() === 'kim', 'relation alias');
        self::check(count($b->getMembers()) === 1 && $b->getServiceRegionModel()->getName() === 'module', 'relations');
        $limited = (new User())($db)->relations((new Author())->matchSeqWithUserSeq()->orderBySeqDesc()->groupLimit(1))
            ->orderBySeqAsc()
            ->gets();
        $got = $limited->first()->getAuthorModels();
        self::check(count($got) === 1 && $got->first()->getName() === 'gamma', 'groupLimit');
        $other = \Polyspec\Orm\Tests\Model\connect($dsn, $db->config());
        $external = (new Author())($db)->relation(
            (new User())($other)->matchUserSeqWithSeq()->aliasOwner()
        )->getByName('beta');
        self::check($external->getOwner()?->getName() === 'lee', 'relation on another connection');
        self::check(
            self::code(fn() => (new Author())($db)->joinUserSeqWithSeq((new User())($db))->gets()) === Code::CONFIG,
            'join child with connection'
        );
        self::check(
            self::code(fn() => (new Author())($db)->name('a')->or(new User())->gets()) === Code::CONFIG,
            'unjoined model placement'
        );
        $array = $b->toArray();
        self::check(($array['writer']['name'] ?? null) === 'kim' && $array['name'] === 'alpha', 'toArray');
        $json = json_decode((string) json_encode($b), true);
        self::check(($json['writer']['name'] ?? null) === 'kim', 'json');
    }

    private static function caseColumnsAndSubqueries(Db $db, string $dsn): void
    {
        $f = self::seed($db);
        $users = (new User())($db)
            ->addColumnReadTotal(fn(User $u) => (new Author())->sumReadCount()->userSeqEqSeq($u))
            ->seq((new Author())->addColumnUserSeq()->isClose(false))
            ->orderBySeqAsc()->gets();
        self::check(count($users) === 1, 'subquery IN');
        $u = $users->first();
        self::check((int) $u->getReadTotal() === 20, 'added column');
        $svc = $f['service']->getSeq();
        self::check((new Author())($db)->serviceSeq($svc)->sumReadCount()->getSum() === 60.0, 'sum');
        self::check((new Author())($db)->serviceSeq($svc)->avgReadCount()->getAvg() === 15.0, 'avg');
        self::check((new Author())($db)->seq(-1)->sumReadCount()->getSum() === 0.0, 'sum over no rows');
        self::check((new Author())($db)->seq(-1)->avgReadCount()->getAvg() === null, 'avg over no rows');
        self::check((new Author())($db)->seq(-1)->get() === null, 'get over no rows');
        self::check(count((new Author())($db)->groupByIsClose()->getsCount()) === 2, 'getsCount');
        $page = (new Author())($db)->orderBySeqAsc()->getsPage(2, 3);
        self::check(
            $page->totalCount === 4 && $page
                ->totalPages === 2 && count($page->items) === 1 && $page
                ->items
                ->first()
                ->getName() === 'delta',
            'page'
        );
        self::check((new Author())($db)->keyNameName()->gets()->get('beta') !== null, 'keyName');
        foreach ([10, 11] as $a) {
            foreach ([1, 2] as $tenant) {
                (new CompositeAccount())($db)->setTenantId($tenant)->setAccountId($a)->setName('n')->create();
            }
        }
        $memberships = [
            (new CompositeMembership())->setTenantId(1)->setAccountId(10)->setRole('owner'),
            (new CompositeMembership())->setTenantId(1)->setAccountId(11)->setRole('member'),
            (new CompositeMembership())->setTenantId(2)->setAccountId(10)->setRole('member'),
        ];
        self::check((new CompositeMembership())($db)->creates($memberships, 2) === 3, 'creates');
        self::check(
            (new CompositeMembership())($db)->tupleTenantIdWithAccountId([[1, 10], [2, 10]])->getCount() === 2,
            'tuple'
        );
        $fetched = (new Author())($db)->orderBySeqAsc()->fetchValue(fn(Author $b) => strtoupper($b->getName()))->gets();
        self::check($fetched->fetchedValues() === ['ALPHA', 'BETA', 'GAMMA', 'DELTA'], 'fetchValue');
    }

    private static function caseWrites(Db $db, string $dsn): void
    {
        $f = self::seed($db);
        $b = (new Author())($db)->getBySeq($f['authors'][0]->getSeq());
        $b->setName('renamed')->plusReadCount(5)->update(true);
        $again = (new Author())($db)->getBySeq($b->getSeq());
        self::check($again->getName() === 'renamed' && $again->getReadCount() === 5, 'update');
        // Requirements: DSL-155.
        self::check(
            self::code(fn() => $b->setName('stale')->update(true)) === Code::CONFIG,
            'optimistic update without a fresh version'
        );
        $again->setName('again')->update();
        $b->setName('x')->update();
        $item = (new Account())($db)->setName('acc')->newLabel('shown')->create();
        self::check($item->getLabel() === 'shown' && $item->toArray()['label'] === 'shown', 'new value');
        self::check(self::code(fn() => (new Account())->newName('x')) === Code::CONFIG, 'new with a column name');
        $saved = (new Account())($db)->setSeq($item->getSeq())->setName('saved')->save();
        self::check(
            $saved->getName() === 'saved' && (new Account())($db)->getBySeq($item->getSeq())->getName() === 'saved',
            'save as update'
        );
        (new Author())($db)->getBySeq($f['authors'][3]->getSeq())->delete();
        self::check((new Author())($db)->getCount() === 3, 'delete');
        (new Author())($db)->isClose(true)->gets()->delete();
        self::check((new Author())($db)->getCount() === 2, 'collection delete');
        (new CompositeAccount())($db)->setTenantId(9)->setAccountId(9)->setName('first')->create();
        (new CompositeAccount())($db)->setTenantId(9)
            ->setAccountId(9)
            ->setName('first')
            ->duplication((new CompositeAccount())->setName('second'))
            ->create();
        self::check(
            (new CompositeAccount())($db)->getByTenantIdAndAccountId(9, 9)->getName() === 'second',
            'duplication'
        );
        $service = (new Service())($db)->setName('recursive')->create();
        (new ServiceMember())($db)->setServiceSeq($service->getSeq())->setUserSeq($f['users'][0]->getSeq())->create();
        $loaded = (new Service())($db)->relations(
            (new ServiceMember())->matchSeqWithServiceSeq()
        )->getBySeq($service->getSeq());
        $loaded->delete(true);
        self::check(
            (
                new ServiceMember()
            )($db)->getCountByServiceSeq(
                $service->getSeq()
            ) === 0 && (new Service())($db)->getBySeq($service->getSeq()) === null,
            'delete(true)'
        );
    }

    private static function caseStyledValueStates(Db $db, string $dsn): void
    {
        $fixture = json_decode(
            file_get_contents(dirname(__DIR__, 3) . '/contracts/fixtures/styled_column_states.json'),
            true,
            512,
            JSON_THROW_ON_ERROR
        );
        $cases = array_column($fixture['cases'], null, 'id');
        $seed = self::seed($db);
        $seq = $seed['authors'][0]->getSeq();
        $pdo = $db->pdo();
        $pdo->beginTransaction();
        try {
            $row = (new Author())($db)->addAllColumns()->getBySeq($seq);
            self::check(
                $row->getJsonSetting() instanceof StyledValue && $row->getJsonSetting()->kind === 'sql-null',
                'SQL NULL getter'
            );
            self::check($row->toArray()['json_setting'] === $cases['sql_null']['output'], 'SQL NULL array output');
            self::check(
                json_decode(
                    $row->toJson(),
                    true,
                    512,
                    JSON_THROW_ON_ERROR
                )['json_setting'] === $cases['sql_null']['output'],
                'SQL NULL JSON output'
            );
            $partial = (new Author())($db)->removeAllColumns()->addColumnName()->getBySeq($seq);
            self::check(
                self::code(fn() => $partial->getJsonSetting()) === Code::COLUMN_UNSELECTED,
                'unselected getter'
            );

            $row->setJsonSetting(StyledValue::value(\Polyspec\OrderedJson\parse('null')))
                ->setJsonsTags(StyledValue::value(\Polyspec\OrderedJson\parse('null')))
                ->setSerializeData(StyledValue::value(null))
                ->update();
            $loaded = (new Author())($db)->addAllColumns()->getBySeq($seq);
            self::check($loaded->getJsonSetting()->kind === 'value', 'JSON null getter');
            self::check(
                json_decode(
                    Model::jsonText($loaded->toArray()['json_setting']),
                    true,
                    512,
                    JSON_THROW_ON_ERROR
                ) === $cases['json_null']['output'],
                'JSON null array output'
            );
            self::check(
                json_decode(
                    Model::jsonText($loaded->toArray()['jsons_tags']),
                    true,
                    512,
                    JSON_THROW_ON_ERROR
                ) === $cases['jsons_value_null']['output'],
                'JSONS null array output'
            );
            self::check(
                $loaded->toArray()['serialize_data'] === $cases['serialize_value_null']['output'],
                'serialize null array output'
            );
            $json = json_decode($loaded->toJson(), true, 512, JSON_THROW_ON_ERROR);
            self::check(
                $json['json_setting'] === $cases['json_null']['output'] && $json['serialize_data'] === $cases[
                    'serialize_value_null'
                ]['output'],
                'encoded null JSON output'
            );
            $cell = $pdo->prepare('SELECT json_setting, jsons_tags, serialize_data FROM author WHERE seq = ?');
            $cell->execute([$seq]);
            $stored = $cell->fetch(\PDO::FETCH_ASSOC);
            self::check(
                $stored['json_setting'] === 'null' && $stored['jsons_tags'] === 'null' && $stored[
                    'serialize_data'
                ] === 'N;',
                'encoded null storage'
            );

            $loaded->setJsonSetting(StyledValue::value(\Polyspec\OrderedJson\parse('{"kind":"sql-null"}')))->update();
            $again = (new Author())($db)->addAllColumns()->getBySeq($seq);
            self::check(
                json_decode(
                    Model::jsonText($again->toArray()['json_setting']),
                    true,
                    512,
                    JSON_THROW_ON_ERROR
                ) === $cases['json_object_with_kind']['output'],
                'JSON document does not collide with state tag'
            );

            $again->setJsonSetting(StyledValue::sqlNull())
                ->setJsonsTags(StyledValue::sqlNull())
                ->setSerializeData(StyledValue::sqlNull())
                ->update();
            $nulls = (new Author())($db)->addAllColumns()->getBySeq($seq);
            self::check($nulls->toArray()['json_setting'] === $cases['sql_null']['output'], 'SQL NULL restored');
            $cell = $pdo->prepare('SELECT json_setting, jsons_tags, serialize_data FROM author WHERE seq = ?');
            $cell->execute([$seq]);
            $stored = $cell->fetch(\PDO::FETCH_ASSOC);
            self::check(
                $stored['json_setting'] === null && $stored['jsons_tags'] === null && $stored[
                    'serialize_data'
                ] === null,
                'SQL NULL storage'
            );

            $pdo->prepare('UPDATE author SET json_setting = ? WHERE seq = ?')->execute(['', $seq]);
            self::check(
                self::code(fn() => (new Author())($db)->addAllColumns()->getBySeq($seq)) === Code::CODEC_DECODE,
                'empty JSON text rejected'
            );
        } finally {
            $pdo->rollBack();
        }
    }

    // ip, gz, and base64 codec columns store the value and read it back, and the ip column is found by equality.
    private static function caseCodecColumns(Db $db, string $dsn): void
    {
        $f = self::seed($db);
        $seq = $f['authors'][0]->getSeq();
        (new Author())($db)->getBySeq($seq)->setIp('10.0.0.1')->setGzExtend(StyledValue::value('compressed text'))
            ->setBase64Extra(StyledValue::value('plain'))->update();
        $row = (new Author())($db)->addAllColumns()->getBySeq($seq);
        self::check($row->getIp() === '10.0.0.1', 'ip ' . var_export($row->getIp(), true));
        self::check($row->getGzExtend()->payload() === 'compressed text', 'gz styled value');
        self::check($row->getBase64Extra()->payload() === 'plain', 'base64 styled value');
        self::check((new Author())($db)->ip('10.0.0.1')->getCount() === 1, 'ip condition');
        self::check(
            (new Author())($db)->addAllColumns()
                ->getBySeq($f['authors'][1]->getSeq())
                ->getGzExtend()
                ->kind === 'sql-null',
            'gz SQL NULL'
        );
        $stored = $db->pdo()->query('SELECT base64_extra FROM author WHERE seq = ' . $seq)->fetchColumn();
        self::check($stored === base64_encode('plain'), 'base64 storage');
    }

    private static function caseTransactions(Db $db, string $dsn): void
    {
        // A transaction runs only through transaction(): Db has no public method that begins, commits or rolls one
        // back. The test of DSL-124 (docs/spec/dsl.md "Transactions").
        $public = array_map(
            static fn(ReflectionMethod $m): string => strtolower($m->getName()),
            (new ReflectionClass(Db::class))->getMethods(ReflectionMethod::IS_PUBLIC)
        );
        self::check(in_array('transaction', $public, true), 'Db has transaction()');
        self::check(
            array_values(
                array_filter($public, static fn(string $n): bool => preg_match('/^(begin|commit|rollback)/', $n) === 1)
            ) === [],
            'no public begin, commit or rollback'
        );
        $boom = new RuntimeException('boom');
        try {
            $db->transaction(function () use ($boom): void {
                (new User())->setName('rolled back')->create();
                throw $boom;
            });
            self::check(false, 'rollback did not throw');
        } catch (RuntimeException $e) {
            self::check($e === $boom, 'rollback error');
        }
        self::check((new User())($db)->getCount() === 0, 'rollback');
        $result = $db->transaction(function () use ($db, $boom): string {
            (new User())->setName('outer')->create();
            try {
                $db->transaction(function () use ($boom): void {
                    (new User())->setName('inner')->create();
                    throw $boom;
                });
            } catch (RuntimeException $rolledBack) {
                self::check($rolledBack instanceof RuntimeException, 'the failing savepoint rolled back');
            }
            self::check((new User())->getCount() === 1, 'savepoint rollback');
            (new User())->name('outer')->forUpdate()->gets();
            $db->utils()->lock('users');
            $db->utils()->setLocal('ormtest.actor', 'tester');
            self::check($db->utils()->local('ormtest.actor') === 'tester', 'local');
            self::check(self::code(fn() => $db->utils()->local('ormtest.missing')) === Code::NO_ROWS, 'missing local');
            return 'done';
        }, isolation: 'read_committed', retry: 0);
        self::check($result === 'done', 'transaction result');
        self::check((new User())($db)->getCount() === 1, 'commit');
        self::check(
            self::code(fn() => (new User())($db)->forUpdate()->gets()) === Code::CONFIG,
            'lock outside a transaction'
        );
        self::check(self::code(fn() => $db->utils()->lock('x')) === Code::CONFIG, 'lock utility outside a transaction');
        $attempts = 0;
        $db->transaction(function () use (&$attempts): void {
            $attempts++;
            if ($attempts < 3) {
                throw Orm::transactionConflict('retry');
            }
        });
        self::check($attempts === 3, 'retry');
        self::check(
            self::code(
                fn() => $db->transaction(fn() => $db->transaction(fn() => null, readOnly: true))
            ) === Code::CONFIG,
            'nested options'
        );
        self::check($db->utils()->schema()->empty() === false, 'schema empty');
        self::check($db->utils()->stats()->openConnections === 1, 'stats');
        self::check($db->stats() == $db->utils()->stats(), 'Db stats are the utility stats');
    }

    private static function caseUtilities(Db $db, string $dsn): void
    {
        $schema = $db->utils()->schema();
        $broken = "dbspec 1 broken\n\ntable t {\n}\n";
        self::check(
            self::code(
                fn() => $schema->install(new \Polyspec\Orm\Schema($broken, 'sha256:' . hash('sha256', $broken)))
            ) === Code::SCHEMA_INVALID,
            'install an invalid document'
        );
        $user = (new User())($db)->setName('kept')->create();
        $schema->install(\Polyspec\Orm\Tests\Model\schema());
        self::check((new User())($db)->seq($user->getSeq())->get()?->getName() === 'kept', 'install again keeps rows');
        $db->pdo()->exec(
            $db->driver() === 'postgres' ? 'DROP TABLE "task" CASCADE' : (
                $db->driver() === 'mysql' ? 'DROP TABLE `task`' : 'DROP TABLE "task"'
            )
        );
        self::check(
            self::code(fn() => $schema->install(\Polyspec\Orm\Tests\Model\schema())) === Code::CONFIG,
            'install over some tables of the set'
        );
        self::check(self::code(fn() => $schema->exists('bad name')) === Code::CONFIG, 'invalid schema name');
        $privileges = $db->utils()->privileges();
        switch ($db->driver()) {
            case 'mysql':
                $name = ltrim((string) parse_url($dsn, PHP_URL_PATH), '/');
                self::check(
                    $schema->exists($name) && $schema
                        ->installed($name, 'user') && !$schema
                        ->installed($name, 'missing'),
                    'mysql schema inspection'
                );
                self::check(
                    self::code(fn() => $privileges->inspectTable('public.user')) === Code::CAPABILITY_UNSUPPORTED,
                    'mysql privileges'
                );
                break;
            case 'postgres':
                self::check(
                    $schema->exists('public') && $schema
                        ->installed('public', 'user') && !$schema
                        ->installed('public', 'missing'),
                    'postgres schema inspection'
                );
                $got = $privileges->inspectTable('public.user');
                self::check($got['select'] && $got['insert'], 'inspectTable');
                self::check(
                    self::code(fn() => $privileges->inspectTable('user')) === Code::CONFIG,
                    'unqualified table'
                );
                self::check(
                    self::code(fn() => $privileges->revokeTable('public.user', 'drop', 'nobody')) === Code::CONFIG,
                    'unsupported privilege'
                );
                break;
            default:
                self::check(!$schema->installed('ormexample', 'user'), 'sqlite schema inspection');
                self::check(
                    self::code(fn() => $privileges->grantTable('public.user', 'orm')) === Code::CAPABILITY_UNSUPPORTED,
                    'sqlite privileges'
                );
        }
    }

    private static function caseDeadlockRetry(Db $db, string $dsn): void
    {
        $f = self::seed($db);
        [$a, $b] = [$f['authors'][0]->getSeq(), $f['authors'][1]->getSeq()];
        $children = [];
        foreach ([[$a, $b, 'one'], [$b, $a, 'two']] as [$first, $second, $tag]) {
            $p = proc_open(
                [PHP_BINARY, __DIR__ . '/deadlock_child.php', $dsn, (string) $first, (string) $second, $tag],
                [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
                $pipes
            );
            $children[] = [$p, $pipes];
        }
        foreach ($children as [, $pipes]) {
            self::check(trim((string) fgets($pipes[1])) === 'locked', 'child did not lock its first row');
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
            self::check($status === 0 && str_starts_with($out, 'done '), "child failed ($status): $out $err");
            $runs[] = (int) substr($out, 5);
        }
        sort($runs);
        self::check($runs === [1, 2], 'closure runs: ' . implode(',', $runs));
    }

    private static function caseAesRotation(Db $db, string $dsn): void
    {
        $f = self::seed($db);
        $b = (new Author())($db)->getBySeq($f['authors'][0]->getSeq());
        $b->setAesHexEmail('person@example.com')->update();
        self::check((new Author())($db)->aesHexEmail('person@example.com')->getCount() === 1, 'blind index condition');
        $keyring = new AesKeyring([1 => 'test-aes-key', 2 => 'next-aes-key'], 2);
        $status = $db->utils()->aes()->status(new Author(), $keyring);
        self::check($status->total === 4 && $status->pending === 4, 'status');
        self::check($db->utils()->aes()->rotate(new Author(), $keyring) === 4, 'rotate');
        self::check($db->utils()->aes()->status(new Author(), $keyring)->pending === 0, 'after rotation');
        // A write with only aesKeys and aesVersion encrypts with aesKeys[aesVersion].
        $versioned = \Polyspec\Orm\Tests\Model\connect(
            $dsn,
            new Config(
                blindIndexKey: 'test-blind-key',
                aesVersion: 2,
                aesKeys: [1 => 'test-aes-key', 2 => 'next-aes-key']
            )
        );
        (new Author())($versioned)->getBySeq($f['authors'][1]->getSeq())
            ->setAesHexEmail('second@example.com')
            ->update();
        $current = \Polyspec\Orm\Tests\Model\connect(
            $dsn,
            new Config(blindIndexKey: 'test-blind-key', aesVersion: 2, aesKeys: [2 => 'next-aes-key'])
        );
        self::check(
            (new Author())($current)->getBySeq($f['authors'][1]->getSeq())->getAesHexEmail() === 'second@example.com',
            'write with the key of aesVersion'
        );
        self::check(
            self::code(fn() => new Config(aesKey: 'other-key', aesKeys: [1 => 'test-aes-key'])) === Code::CONFIG,
            'aesKey differs from aesKeys[aesVersion]'
        );
    }

    // Inserts and reads more values than SQLite binds in one statement: the inserts
    // and the root IN list are split, duplicate IN values are read once, and a shape
    // that a merge would change is rejected.
    private static function caseBindLimitSplitting(Db $db, string $dsn): void
    {
        $n = 1200;
        $rows = [];
        $names = [];
        for ($i = 0; $i < $n; $i++) {
            $name = sprintf('chunk-%04d', $i);
            $rows[] = (new Service())->setName($name);
            $names[] = $name;
        }
        self::check((new Service())($db)->creates($rows, 500) === $n, 'inserted rows');
        $names = array_merge($names, array_slice($names, 0, 200));
        for ($i = 0; $i < 100; $i++) {
            $names[] = "missing-$i";
        }
        self::check(count((new Service())($db)->name($names)->gets()) === $n, 'found rows');
        self::check((new Service())($db)->name($names)->getCount() === $n, 'count');
        if ($db->driver() === 'sqlite') {
            self::check(
                self::code(fn() => (new Service())($db)->name($names)->limit(0, 10)->gets()) === Code::IR_INVALID,
                'limited split'
            );
        }
    }

    // Multi-row inserts run as batches of the given size (docs/spec/protocol.md "Relation steps"; the shared cases of
    // contracts/fixtures/insert_parts.json run in InsertPartsTest.php): each batch is one insert statement, a batch
    // that is not positive is CONFIG and one over the bind limit is BATCH_TOO_LARGE before any statement, the rows keep
    // their order, and a failing batch leaves no row of the call.
    private static function caseInsertParts(Db $db): void
    {
        $inserts = [];
        $unsubscribe = $db->subscribe(static function (\Polyspec\Orm\StatementEvent $e) use (&$inserts): void {
            if ($e->kind === \Polyspec\Orm\StatementEvent::INSERT) {
                $inserts[] = $e;
            }
        });
        $three = array_map(static fn(int $i): Service => (new Service())->setName("refused-$i"), range(1, 3));
        self::check(self::code(fn() => (new Service())($db)->creates($three, 0)) === Code::CONFIG, 'batch 0 is CONFIG');
        $limit = Db::bindLimit($db->driver()) + 1;
        // The refusal counts rows and columns before any statement, so one model repeated proves it; distinct
        // models would cost about 1.8 KB each, 115 MB for the mysql limit (T216).
        $over = array_fill(0, $limit, (new Service())->setName('over'));
        self::check(
            self::code(fn() => (new Service())($db)->creates($over, $limit)) === Code::BATCH_TOO_LARGE,
            'a batch over the bind limit is BATCH_TOO_LARGE'
        );
        self::check($inserts === [], 'refused creates send no insert');
        $inserts = [];
        $labels = array_map(static fn(int $i): string => sprintf('order-%02d', 12 - $i), range(0, 12));
        self::check(
            (new Service())($db)->creates(
                array_map(static fn(string $l): Service => (new Service())->setName($l), $labels),
                6
            ) === 13,
            'creates 13 rows'
        );
        self::check(
            array_map(static fn($e): int => count($e->binds), $inserts) === [6, 6, 1],
            'batches 6, 6, 1: ' . json_encode(array_map(static fn($e): int => count($e->binds), $inserts))
        );
        $read = (new Service())($db)->name($labels)->orderBySeqAsc()->gets()->all();
        self::check(
            array_map(static fn(Service $s): string => $s->getName(), $read) === $labels,
            'rows keep the given order'
        );
        $unsubscribe();
        $before = (new Service())($db)->getCount();
        $rows = array_map(static fn(int $i): Service => (new Service())->setName("rollback-$i"), range(1, 8));
        $rows[] = (fn(): Service => $this->writeColumn('name', null))->call(new Service());
        self::check(
            self::code(fn() => (new Service())($db)->creates($rows, 4)) !== 'no error',
            'a failing batch fails creates'
        );
        self::check((new Service())($db)->getCount() === $before, 'a failing part leaves no row');
    }

    /**
     * Writes the values of another zone as UTC wall clock and reads them as UTC, and the clock default and
     * the text equality filter use the same UTC rule.
     */
    private static function connectionUtc(Db $db): void
    {
        $f = self::seed($db);
        $midnight = new DateTimeImmutable('2026-01-02 09:00:00', new DateTimeZone('+09:00'));
        $before = new DateTimeImmutable('now');
        $created = (new Author())($db)
            ->setName('zone')->setUserSeq($f['users'][0]->getSeq())->setServiceSeq($f['service']->getSeq())
            ->setServiceRegionSeq($f['module']->getSeq())->setServiceMemberSeq($f['member']->getSeq())
            ->setStartDt($midnight->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s'))
                ->setEndDt($midnight->modify('+1 day')->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s'))
                ->create();
        $row = (new Author())($db)->getBySeq($created->getSeq());
        self::check($row !== null, 'row');
        $start = $row->getStartDt();
        self::check(
            $start == $midnight && $start->format('H:i P') === '00:00 +00:00',
            'start_dt ' . $start->format(DATE_ATOM)
        );
        $ts = $row->getCreatedTs();
        self::check(
            abs($ts->getTimestamp() - $before->getTimestamp()) < 60,
            'created_ts ' . $ts->format(DATE_ATOM) . ' at ' . $before->format(DATE_ATOM)
        );
        self::check($ts->getOffset() === 0, 'created_ts zone ' . $ts->format(DATE_ATOM));
        self::check(
            (new Author())($db)->startDt(
                $midnight->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s')
            )->getCount() === 1,
            'equality filter'
        );
        self::check((new Author())($db)->startDt('2026-01-02 00:00:00')->getCount() === 1, 'equality filter by text');
        self::check(
            (new Author())($db)->startDt('2026-01-02T00:00:00.0')->getCount() === 1,
            'equality filter by text with fraction'
        );
        self::check(
            (new Author())($db)->startDt(['2026-01-02 00:00:00', '2026-01-03 00:00:00'])->getCount() === 1,
            'in filter by text'
        );
        self::check(
            (new Author())($db)->betweenStartDt(['2026-01-02 00:00:00', '2026-01-02 00:00:00.5'])->getCount() === 1,
            'between filter by text'
        );
        if ($db->driver() === 'sqlite') {
            try {
                (new Author())($db)->startDt('2026-01-02')->getCount();
                self::check(false, 'date-only datetime text');
            } catch (OrmException $e) {
                self::check($e->code_ === Code::CODEC_ENCODE, 'date-only datetime text: ' . $e->getMessage());
            }
        }
    }

    /**
     * Updates every row of the table in an open transaction of another connection, taking the lock on that row (MySQL,
     * PostgreSQL). Rollback releases the lock.
     */
    private static function holdRows(string $driver, string $dsn, string $table): PDO
    {
        $pdo = case_admin($dsn);
        $quote = $driver === 'mysql' ? static fn(
            string $n
        ): string => "`$n`" : static fn(string $n): string => "\"$n\"";
        $pdo->beginTransaction();
        $pdo->exec('UPDATE ' . $quote($table) . ' SET ' . $quote('seq') . ' = ' . $quote('seq'));
        return $pdo;
    }

    /**
     * Another process holds every row of the PostgreSQL table for $ms milliseconds. The process returns after it holds
     * the rows, and the resource it returns is waited for with proc_close.
     *
     * @return resource
     */
    private static function holdRowsFor(string $dsn, string $table, int $ms)
    {
        $code = 'require ' . var_export(
            dirname(__DIR__, 3) . '/vendor-php/autoload.php',
            true
        ) . '; require ' . var_export(__DIR__ . '/case_database.php', true) . ';'
            . ' $pdo = case_admin(' . var_export($dsn, true) . '); $pdo->beginTransaction();'
            . ' $pdo->exec(' . var_export(
                'UPDATE "' . $table . '" SET "seq" = "seq"',
                true
            ) . '); echo "held\n"; fflush(STDOUT);'
            . ' usleep(' . ($ms * 1000) . '); $pdo->rollBack();';
        $process = proc_open([PHP_BINARY, '-r', $code], [1 => ['pipe', 'w']], $pipes);
        if (!is_resource($process) || trim((string) fgets($pipes[1])) !== 'held') {
            throw new RuntimeException('the holder process did not hold the rows');
        }
        return $process;
    }

    /** Reads the row of $model with FOR UPDATE in $db's transaction. Waits if another connection holds that row. */
    private static function lockedRead(\Polyspec\Orm\Db $db, string $model): void
    {
        $db->transaction(static function () use ($db, $model): void {
            (new $model())($db)->forUpdate()->get();
        }, retry: 0);
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
    private static function awaitReplica(string $driver, string $primary, string $replica): void
    {
        [, $pdoDsn, $user, $password] = Orm::parseDsn($primary);
        $source = new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        if ($driver === 'postgres') {
            $source->beginTransaction();
            $source->exec('SET LOCAL synchronous_commit = remote_apply');
            $mode = $source->query(
                "SELECT current_setting('synchronous_commit'), pg_logical_emit_message(true, 'orm-test-barrier', '')"
            )->fetchColumn();
            if ($mode !== 'remote_apply') {
                throw new RuntimeException("synchronous_commit of the barrier transaction is $mode");
            }
            $source->commit();
            return;
        }
        $status = $source->query('SHOW BINARY LOG STATUS')->fetch(PDO::FETCH_NUM);
        [, $pdoDsn, $user, $password] = Orm::parseDsn($replica);
        $target = new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        // The deadline is 60 s: the replica applies the writes of all clients running in parallel in turn, so on a 4
        // vCPU Linux runner it could not reach the primary's position within 10 s.
        $st = $target->prepare('SELECT SOURCE_POS_WAIT(?, ?, 60)');
        $st->execute([$status[0], (int) $status[1]]);
        $waited = $st->fetchColumn();
        if ($waited === null || (int) $waited < 0) {
            throw new RuntimeException("the replica did not reach {$status[0]}:{$status[1]}");
        }
    }

    /** The message of the error that fn threw. 'no error' if there was none. */
    private static function failureMessage(callable $fn): string
    {
        try {
            $fn();
        } catch (Throwable $e) {
            return $e->getMessage();
        }
        return 'no error';
    }

    /**
     * Checks that the message holds both the callback error and the error at the end of the transaction, in a ROLLBACK.
     */
    private static function checkBoth(string $what, string $message, string $cause, string $end): void
    {
        self::check(
            str_starts_with(
                $message,
                "ROLLBACK: transaction failed ($cause) and rollback failed ("
            ) && str_contains($message, $end),
            "$what reports the cause and the failed transaction end: $message"
        );
    }

    public static function setUpBeforeClass(): void
    {
        self::fixture();
    }

    protected function setUp(): void
    {
        self::$caseDatabases = [];
    }

    /** Drops the case databases of the test, also when it failed; a failed drop fails the test. */
    protected function tearDown(): void
    {
        $databases = array_reverse(self::$caseDatabases);
        self::$caseDatabases = [];
        foreach ($databases as $database) {
            $database->drop();
        }
    }

    /** @return iterable<string, array{string}> the drivers, each a data set */
    public static function drivers(): iterable
    {
        foreach (['sqlite', 'mysql', 'postgres'] as $driver) {
            yield $driver => [$driver];
        }
    }

    /** @return iterable<string, array{string}> the server drivers, each a data set */
    public static function serverDrivers(): iterable
    {
        foreach (['mysql', 'postgres'] as $driver) {
            yield $driver => [$driver];
        }
    }

    /**
     * @return iterable<string, array{string, string}> the connection time zones on each driver, named <zone>/<driver>
     */
    public static function zones(): iterable
    {
        foreach (['sqlite', 'mysql', 'postgres'] as $driver) {
            foreach (['', '+00:00', 'UTC', '+09:00', 'Asia/Seoul'] as $zoneName) {
                yield "$zoneName/$driver" => [$zoneName, $driver];
            }
        }
    }

    #[DataProvider('drivers')]
    public function testSchemaEmpty(string $driver): void
    {
        self::schemaEmpty($driver, self::caseDsn($driver));
    }

    #[DataProvider('drivers')]
    // Requirements: CFG-4, CFG-5.
    public function testPoolOptions(string $driver): void
    {
        $dsn = self::$targets[$driver];
        // A Db holds one connection. The PHP client has no pool and refuses the pool options.
        $db = \Polyspec\Orm\Tests\Model\connect($dsn, new Config());
        self::check($db->utils()->stats()->maxOpenConnections === 1, 'one connection per Db');
        foreach (
            [
            'poolSize: 3' => new Config(poolSize: 3),
            'poolSize: -1' => new Config(poolSize: -1),
            'poolIdleSize: 1' => new Config(poolIdleSize: 1),
            'poolLifetimeMs: 1000' => new Config(poolLifetimeMs: 1000)
            ] as $option => $config
        ) {
            $error = null;
            try {
                \Polyspec\Orm\Tests\Model\connect($dsn, $config);
            } catch (OrmException $e) {
                $error = $e;
            }
            self::check(
                $error?->code_ === Code::CONFIG && str_contains($error->getMessage(), 'PgBouncer or ProxySQL'),
                "$option is refused with CONFIG naming the poolers: " . (
                    $error === null ? 'connected' : $error->getMessage()
                )
            );
        }
    }

    #[DataProvider('drivers')]
    // Requirements: CFG-6.
    public function testStatementTimeout(string $driver): void
    {
        $dsn = self::$targets[$driver];
        self::check(
            self::code(
                fn() => \Polyspec\Orm\Tests\Model\connect($dsn, new Config(statementTimeoutMs: -1))
            ) === Code::CONFIG,
            'negative statement timeout'
        );
        // MySQL bounds SELECT statements with max_execution_time, PostgreSQL
        // bounds every statement, and SQLite has no session timeout. The bounded
        // statement is a locking read of a row that another connection holds, so
        // it waits past the bound.
        if ($driver !== 'sqlite') {
            $caseDsn = self::caseDsn($driver);
            $db = self::database($driver, $caseDsn);
            self::seed($db);
            $db->close();
            $holder = self::holdRows($driver, $caseDsn, 'author');
            $bounded = \Polyspec\Orm\Tests\Model\connect(
                $caseDsn,
                new Config(aesKey: 'test-aes-key', blindIndexKey: 'test-blind-key', statementTimeoutMs: 200)
            );
            self::check(
                self::code(fn() => self::lockedRead($bounded, Author::class)) === Code::CANCELED,
                'a statement past the timeout'
            );
            $bounded->close();
            $holder->rollBack();
        }
    }

    // A pooler in transaction mode hands one server session to every client in
    // turn. Through ORM_TEST_PGBOUNCER_SINGLE_DSN every client shares one server
    // connection, so the statement timeout of one connection must bound only the
    // statements of that connection.
    // PgBouncer's orm_test_single is bound to the database of ORM_TEST_POSTGRES_DSN, so it cannot reach the case
    // database. So this case creates only one table named after itself (case_name()) in that database, and removes only
    // that table at the end (even on failure). The table's model is generated from the dbspec document made during the
    // run. Requirements: CFG-27, CFG-29.
    public function testStatementTimeoutThroughAPooler(): void
    {
        $probeSetup = null;
        $probeTable = null;
        try {
            $single = requiredDsn('ORM_TEST_PGBOUNCER_SINGLE_DSN');
            if ($single === false || $single === '') {
                throw new RuntimeException(
                    'ORM_TEST_PGBOUNCER_SINGLE_DSN is required; database tests never skip; run the test through its '
                    . 'make target, which reads the environment of make orm-test-servers'
                );
            }
            $table = case_name();
            $probe = "dbspec 1 pooler_probe\n\ntable $table {\n  seq i64 identity\n  label varchar(16)\n  primary "
                . "key (seq)\n}\n";
            Generator::generate(
                RuntimeModel::build(RuntimeModel::parse(['pooler_probe.dbs' => $probe])),
                self::$work . "/pooler",
                'Polyspec\\Orm\\Tests\\PoolerProbe'
            );
            spl_autoload_register(static function (string $class): void {
                if (str_starts_with($class, 'Polyspec\\Orm\\Tests\\PoolerProbe\\')) {
                    require self::$work . "/pooler/" . substr(
                        $class,
                        strlen('Polyspec\\Orm\\Tests\\PoolerProbe\\')
                    ) . '.php';
                }
            });
            require self::$work . "/pooler/bootstrap.php";
            $model = 'Polyspec\\Orm\\Tests\\PoolerProbe\\' . str_replace('_', '', ucwords($table, '_'));
            $probeSetup = \Polyspec\Orm\Tests\PoolerProbe\connect(self::$targets['postgres'], new Config());
            $probeTable = $table;
            $probeSetup->utils()->schema()->install(\Polyspec\Orm\Tests\PoolerProbe\schema());
            for ($i = 0; $i < 4; $i++) {
                (new $model())($probeSetup)->setLabel("probe-$i")->create();
            }
            // A direct connection holds the rows, so a locking read through the pooler
            // waits for the lock.
            $holder = self::holdRows('postgres', self::$targets['postgres'], $table);
            $bounded = \Polyspec\Orm\Tests\PoolerProbe\connect($single, new Config(statementTimeoutMs: 200));
            self::check(
                self::code(fn() => self::lockedRead($bounded, $model)) === Code::CANCELED,
                'the bounded connection through the pooler'
            );
            $holder->rollBack();
            $plain = \Polyspec\Orm\Tests\PoolerProbe\connect($single, new Config());
            // Another process holds the rows for a declared 400 ms, past the 200 ms
            // bound of the other connection, so the plain read waits that long.
            $process = self::holdRowsFor(self::$targets['postgres'], $table, 400);
            $started = hrtime(true);
            self::lockedRead($plain, $model);
            self::check(
                (hrtime(true) - $started) / 1e6 >= 200,
                'a connection without a timeout after the bounded one waits past the bound'
            );
            proc_close($process);
            $holder = self::holdRows('postgres', self::$targets['postgres'], $table);
            self::check(
                self::code(fn() => self::lockedRead($bounded, $model)) === Code::CANCELED,
                'the bounded connection after the plain one'
            );
            $holder->rollBack();
            $bounded->close();
            $plain->close();
        } finally {
            if ($probeTable !== null) {
                try {
                    $probeSetup->pdo()->exec("DROP TABLE IF EXISTS \"$probeTable\"");
                } catch (Throwable $e) {
                    self::check(false, "drop table $probeTable: {$e->getMessage()}");
                }
                $probeSetup->close();
            }
        }
    }

    // Requirements: SCH-7.
    public function testInstallInsideATransaction(): void
    {
        $db = self::database('mysql', self::caseDsn('mysql'));
        $inside = null;
        $db->transaction(function () use ($db, &$inside): void {
            try {
                \Polyspec\Orm\Tests\installBench($db);
            } catch (OrmException $e) {
                $inside = $e;
            }
        });
        self::check($inside !== null && $inside->code_ === Code::CONFIG, 'install inside a transaction returns CONFIG');
    }

    #[DataProvider('zones')]
    // Requirements: CFG-2, CFG-7.
    public function testConnectionTimeZone(string $zoneName, string $driver): void
    {
        // The test of DSL-141, DIA-57 (docs/spec).
        $base = self::$targets[$driver];
        $utc = in_array($zoneName, ['', '+00:00', 'UTC'], true);
        // The UTC connection installs a schema, so it uses its own case database; the refused connection uses the
        // shared database.
        $plain = preg_replace('/[?&]timezone=[^&]*/', '', $utc ? self::caseDsn($driver) : $base);
        $dsn = $zoneName === '' ? $plain : $plain . (
            str_contains($plain, '?') ? '&' : '?'
        ) . 'timezone=' . rawurlencode($zoneName);
        if ($utc) {
            self::connectionUtc(self::database($driver, $dsn));
        } else {
            self::check(
                self::code(fn() => \Polyspec\Orm\Tests\Model\connect($dsn, new Config())) === Code::CONFIG,
                'a time zone other than UTC'
            );
        }
    }

    // A connection to the primary and one to its replica work side by side. A
    // model uses the connection it is connected to and no other, and a model
    // without a connection inside a transaction uses the transaction.
    #[DataProvider('serverDrivers')]
    // Requirements: CFG-21, CFG-22.
    public function testPrimaryAndReplica(string $driver): void
    {
        $env = strtoupper($driver);
        $replica = requiredDsn("ORM_TEST_{$env}_REPLICA_DSN");
        if ($replica === false || $replica === '') {
            throw new RuntimeException(
                "ORM_TEST_{$env}_REPLICA_DSN is required; database tests never skip; run the test through its make "
                . "target, which reads the environment of make orm-test-servers"
            );
        }
        // The replica copies the primary's case database under the same name. MySQL needs that database on the replica
        // before it can connect, so it waits on the shared replica database and then connects.
        $primary = self::caseDatabase($driver);
        $master = self::database($driver, $primary->dsn);
        $name = 'replica-' . hrtime(true);
        (new User())($master)->setName($name)->create();
        self::awaitReplica($driver, $primary->dsn, $replica);
        $slave1 = \Polyspec\Orm\Tests\Model\connect(
            $primary->related($replica),
            new Config(aesKey: 'test-aes-key', blindIndexKey: 'test-blind-key')
        );
        self::check(
            (new User())($slave1)->name($name)->getCount() === 1,
            'the replica reads the row written through the primary'
        );
        self::check(
            self::code(fn() => (new User())($slave1)->setName("$name-replica")->create()) === Code::READ_ONLY,
            'a write through the replica connection is rejected'
        );
        self::check(
            (new User())($master)->name("$name-replica")->getCount() === 0,
            'a write through the replica connection does not reach the primary'
        );
        // A row read through the replica is written through the primary.
        (new User())($slave1)->name($name)->get()->connect($master)->setName("$name-renamed")->update();
        $master->transaction(function () use ($master, $slave1, $name): void {
            (new User())->setName("$name-tx")->create();
            self::check(
                (new User())($master)->name("$name-tx")->getCount() === 1,
                'the primary connection inside its transaction'
            );
            self::check(
                (new User())($slave1)->name("$name-tx")->getCount() === 0,
                'the replica connection reads no uncommitted row'
            );
        });
        self::awaitReplica($driver, $primary->dsn, $replica);
        self::check(
            (new User())($slave1)->name(["$name-renamed", "$name-tx"])->getCount() === 2,
            'the replica reads the committed rows'
        );
        $slave1->close();
        $master->close();
    }

    // A connection to a SQLite database file that the process may only read:
    // SQLite opens it read-only, reads succeed, and a write returns READ_ONLY.
    // Requirements: CFG-24.
    public function testReadOnly(): void
    {
        $path = self::$work . "/read-only.sqlite";
        $writable = self::database('sqlite', "sqlite://$path");
        (new User())($writable)->setName('read-only')->create();
        $writable->close();
        chmod($path, 0o444);
        $readOnly = \Polyspec\Orm\Tests\Model\connect(
            "sqlite://$path",
            new Config(aesKey: 'test-aes-key', blindIndexKey: 'test-blind-key')
        );
        self::check(
            (new User())($readOnly)->name('read-only')->getCount() === 1,
            'the read-only database reads the row'
        );
        self::check(
            self::code(fn() => (new User())($readOnly)->setName('rejected')->create()) === Code::READ_ONLY,
            'a write to the read-only database'
        );
        $readOnly->close();
    }

    // If the MySQL local value reset at the end of the transaction fails, commit and rollback report that error.
    // A MySQL user variable remains after COMMIT and ROLLBACK.
    // (mysql.context.user_variable_session_scope).
    public function testFailedLocalReset(): void
    {
        [, $pdoDsn, $user, $password] = Orm::parseDsn(self::$targets['mysql']);
        $pdo = new ModelTestFailingPdo($pdoDsn, $user, $password);
        $pdo->rejects = static fn(string $sql): bool => str_starts_with(
            $sql,
            'SET @`orm.'
        ) && str_ends_with($sql, '= NULL');
        $failing = new Db($pdo, 'mysql', new Config(), new DateTimeZone('UTC'));
        $committed = self::failureMessage(fn() => $failing->transaction(function () use ($failing): void {
            $failing->utils()->setLocal('ormtest.actor', 'tester');
        }));
        self::check(
            str_contains($committed, 'statement rejected by the test driver'),
            "commit reports the failed reset: $committed"
        );
        $rolledBack = self::failureMessage(fn() => $failing->transaction(function () use ($failing): void {
            $failing->utils()->setLocal('ormtest.actor', 'tester');
            throw new RuntimeException('callback failed');
        }));
        self::checkBoth('rollback', $rolledBack, 'callback failed', 'statement rejected by the test driver');
    }

    // If the MySQL RELEASE_LOCK at the end of the transaction fails, or does not release the lock, commit and
    // rollback report that error. A named lock that is not released remains on the connection.
    public function testFailedLockRelease(): void
    {
        [, $pdoDsn, $user, $password] = Orm::parseDsn(self::$targets['mysql']);
        $pdo = new ModelTestFailingPdo($pdoDsn, $user, $password);
        $failing = new Db($pdo, 'mysql', new Config(), new DateTimeZone('UTC'));
        $key = static fn(string $name): string => "orm_test.$name." . getmypid();
        $pdo->rejects = static fn(string $sql): bool => str_starts_with($sql, 'SELECT RELEASE_LOCK');
        $committed = self::failureMessage(fn() => $failing->transaction(function () use ($failing, $key): void {
            $failing->utils()->lock($key('commit'));
        }, retry: 0));
        self::check(
            str_contains($committed, 'statement rejected by the test driver'),
            "commit reports the failed release: $committed"
        );
        $rolledBack = self::failureMessage(fn() => $failing->transaction(function () use ($failing, $key): void {
            $failing->utils()->lock($key('rollback'));
            throw new RuntimeException('callback failed');
        }, retry: 0));
        self::checkBoth('rollback', $rolledBack, 'callback failed', 'statement rejected by the test driver');
        $pdo->rejects = null;
        // If the lock is released in advance, RELEASE_LOCK at the end of the transaction returns 0.
        $notHeld = self::failureMessage(fn() => $failing->transaction(function () use ($failing, $pdo, $key): void {
            $failing->utils()->lock($key('released'));
            $pdo->prepare('DO RELEASE_LOCK(?)')->execute([$key('released')]);
        }, retry: 0));
        self::check(
            str_contains($notHeld, 'lock ' . $key('released') . ' was not held at transaction end'),
            "a lock released early is reported: $notHeld"
        );
    }

    // If the native rollback, the SQLite mode restore, or the rollback after begin fails, the transaction
    // reports that error together with its cause.
    public function testFailedRollback(): void
    {
        $pdo = new ModelTestFailingPdo("sqlite:" . self::$work . "/transaction-end.sqlite");
        $failing = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));
        $pdo->rejectRollback = true;
        $rolledBack = self::failureMessage(fn() => $failing->transaction(function (): void {
            throw new RuntimeException('callback failed');
        }, retry: 0));
        self::checkBoth('rollback', $rolledBack, 'callback failed', 'rollback rejected by the test driver');
        $pdo->rejects = static fn(string $sql): bool => $sql === 'PRAGMA query_only = 1';
        $began = self::failureMessage(fn() => $failing->transaction(fn() => null, readOnly: true, retry: 0));
        // A driver error that is not in the catalog is a cause with the code DRIVER.
        self::checkBoth(
            'begin',
            $began,
            'DRIVER: statement rejected by the test driver',
            'rollback rejected by the test driver'
        );
        $pdo->rejectRollback = false;
        $pdo->rejects = static fn(string $sql): bool => $sql === 'PRAGMA query_only = 0';
        $committed = self::failureMessage(fn() => $failing->transaction(fn() => null, readOnly: true, retry: 0));
        self::check(
            str_contains($committed, 'statement rejected by the test driver'),
            "commit reports the failed mode reset: $committed"
        );
        $rolledBack = self::failureMessage(fn() => $failing->transaction(function (): void {
            throw new RuntimeException('callback failed');
        }, readOnly: true, retry: 0));
        self::checkBoth('mode reset', $rolledBack, 'callback failed', 'statement rejected by the test driver');
    }

    // If the ROLLBACK TO SAVEPOINT or RELEASE SAVEPOINT that ends a nested transaction's savepoint fails,
    // it reports the callback error together with that error, and a callback that succeeded reports the failure of
    // RELEASE SAVEPOINT.
    public function testFailedSavepointEnd(): void
    {
        $pdo = new ModelTestFailingPdo("sqlite:" . self::$work . "/savepoint-end.sqlite");
        $failing = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));
        $nested = static fn(Closure $fn): string => self::failureMessage(
            fn() => $failing->transaction(fn() => $failing->transaction($fn), retry: 0)
        );
        foreach (['ROLLBACK TO SAVEPOINT', 'RELEASE SAVEPOINT'] as $statement) {
            $pdo->rejects = static fn(string $sql): bool => str_starts_with($sql, $statement);
            $failed = $nested(function (): void {
                throw new RuntimeException('callback failed');
            });
            self::checkBoth($statement, $failed, 'callback failed', 'statement rejected by the test driver');
        }
        $pdo->rejects = static fn(string $sql): bool => str_starts_with($sql, 'RELEASE SAVEPOINT');
        $released = $nested(fn() => null);
        self::check(
            str_contains($released, 'statement rejected by the test driver'),
            "a successful callback reports the failed release: $released"
        );
        $pdo->rejects = static fn(string $sql): bool => str_starts_with(
            $sql,
            'ROLLBACK TO SAVEPOINT'
        ) || str_starts_with($sql, 'RELEASE SAVEPOINT');
        $both = $nested(function (): void {
            throw new RuntimeException('callback failed');
        });
        self::checkBoth('both statements', $both, 'callback failed', 'statement rejected by the test driver');
        self::check(
            substr_count($both, 'statement rejected by the test driver') === 2,
            "both savepoint statements are reported: $both"
        );
        $pdo->rejects = null;
    }

    // conditions
    // Requirements: PLN-6, PLN-7, PLN-16, PLN-23, PLN-28, PLN-29, PLN-36, PLN-37, PLN-38, PLN-39.
    #[DataProvider('drivers')]
    public function testConditions(string $driver): void
    {
        $dsn = self::caseDsn($driver);
        $db = self::database($driver, $dsn);
        self::caseConditions($db, $dsn);
    }

    // joins and relations
    // Requirements: DBS-118, CPX-1.
    // Requirements: PLN-10, PLN-41, PLN-42, PLN-43.
    #[DataProvider('drivers')]
    public function testJoinsAndRelations(string $driver): void
    {
        $dsn = self::caseDsn($driver);
        $db = self::database($driver, $dsn);
        self::caseJoinsAndRelations($db, $dsn);
    }

    // columns and subqueries
    // Requirements: PLN-8, PLN-9, PLN-14.
    #[DataProvider('drivers')]
    public function testColumnsAndSubqueries(string $driver): void
    {
        $dsn = self::caseDsn($driver);
        $db = self::database($driver, $dsn);
        self::caseColumnsAndSubqueries($db, $dsn);
    }

    // writes
    // Requirements: PLN-12, PLN-27.
    #[DataProvider('drivers')]
    public function testWrites(string $driver): void
    {
        // The test of DSL-107, DSL-116 (docs/spec).
        $dsn = self::caseDsn($driver);
        $db = self::database($driver, $dsn);
        self::caseWrites($db, $dsn);
    }

    // styled value states
    #[DataProvider('drivers')]
    public function testStyledValueStates(string $driver): void
    {
        $dsn = self::caseDsn($driver);
        $db = self::database($driver, $dsn);
        self::caseStyledValueStates($db, $dsn);
    }

    // codec columns
    #[DataProvider('drivers')]
    public function testCodecColumns(string $driver): void
    {
        $dsn = self::caseDsn($driver);
        $db = self::database($driver, $dsn);
        self::caseCodecColumns($db, $dsn);
    }

    // transactions
    // Requirements: PLN-13, PLN-16, PLN-17, PLN-20, PLN-21.
    #[DataProvider('drivers')]
    public function testTransactions(string $driver): void
    {
        // The test of DSL-118, DSL-119, DSL-123, DSL-125, DSL-126 (docs/spec).
        $dsn = self::caseDsn($driver);
        $db = self::database($driver, $dsn);
        self::caseTransactions($db, $dsn);
    }

    // utilities
    #[DataProvider('drivers')]
    public function testUtilities(string $driver): void
    {
        $dsn = self::caseDsn($driver);
        $db = self::database($driver, $dsn);
        self::caseUtilities($db, $dsn);
    }

    // deadlock retry, on the server drivers: SQLite has one writer, so two transactions cannot hold row locks at the
    // same time and no deadlock can arise.
    // Requirements: PLN-24.
    #[DataProvider('serverDrivers')]
    public function testDeadlockRetry(string $driver): void
    {
        $dsn = self::caseDsn($driver);
        $db = self::database($driver, $dsn);
        self::caseDeadlockRetry($db, $dsn);
    }

    // aes rotation
    #[DataProvider('drivers')]
    public function testAesRotation(string $driver): void
    {
        // The test of COD-8 (docs/spec).
        $dsn = self::caseDsn($driver);
        $db = self::database($driver, $dsn);
        self::caseAesRotation($db, $dsn);
    }

    // bind limit splitting
    #[DataProvider('drivers')]
    public function testBindLimitSplitting(string $driver): void
    {
        $dsn = self::caseDsn($driver);
        $db = self::database($driver, $dsn);
        self::caseBindLimitSplitting($db, $dsn);
    }

    // insert parts
    #[DataProvider('drivers')]
    public function testInsertParts(string $driver): void
    {
        $dsn = self::caseDsn($driver);
        $db = self::database($driver, $dsn);
        self::caseInsertParts($db, $dsn);
    }
}
