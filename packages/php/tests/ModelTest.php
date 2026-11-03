<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// Model integration test on SQLite, MySQL and PostgreSQL. A case that installs
// the schema runs in a case database of its own (case_database.php) created
// through ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN; the cases that only
// connect use those databases and create nothing there. The test fails when
// either is unset.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/ModelTest.php
// [--filter <case>]

use Closure;
use DateTimeImmutable;
use DateTimeZone;
use PDO;
use ReflectionClass;
use ReflectionMethod;
use RuntimeException;
use Throwable;
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
use Polyspec\Orm\Model;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\StyledValue;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\DataProvider;

#[Medium]
class ModelTest extends TestCase
{
    use ThreeDrivers;

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
        $one = (new Author())->connect($db)->getByName('gamma');
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

    private static function caseStyledValueStates(Db $db): void
    {
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
            self::check($loaded->getJsonsTags()->kind === 'value', 'JSONS null getter');
            self::check($loaded->getSerializeData()->kind === 'value', 'serialize null getter');
        } finally {
            $pdo->rollBack();
        }
    }

    // ip, gz, and base64 codec columns store the value and read it back, and the ip column is found by equality.
    private static function caseTransactions(Db $db, string $dsn): void
    {
        // Requirements: PLN-19.
        // A transaction runs only through transaction(): Db has no public method that begins, commits or rolls one
        // back. The test of DSL-124 (docs/spec/dsl.md "Transactions").
        $public = array_map(
            static fn(ReflectionMethod $m): string => strtolower($m->getName()),
            (new ReflectionClass(Db::class))->getMethods(ReflectionMethod::IS_PUBLIC)
        );
        $utils = $db->utils();
        self::check(
            $utils->schema() instanceof \Polyspec\Orm\SchemaUtils
                && $utils->privileges() instanceof \Polyspec\Orm\PrivilegeUtils
                && $utils->aes() instanceof \Polyspec\Orm\AesUtils
                && $utils->stats() instanceof \Polyspec\Orm\Stats,
            'Utils exposes the schema, privileges, AES and stats groups'
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
        $idleStats = $db->stats();
        self::check(
            $idleStats->maxOpenConnections === 1 && $idleStats->openConnections === 1
                && $idleStats->inUse === 0 && $idleStats->idle === 1,
            'idle connection statistics'
        );
        $result = $db->transaction(function () use ($db, $boom): string {
            $busyStats = $db->utils()->stats();
            self::check(
                $busyStats->maxOpenConnections === 1 && $busyStats->openConnections === 1
                    && $busyStats->inUse === 1 && $busyStats->idle === 0,
                'busy connection statistics'
            );
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
        $releasedStats = $db->utils()->stats();
        self::check(
            $releasedStats->maxOpenConnections === 1 && $releasedStats->openConnections === 1
                && $releasedStats->inUse === 0 && $releasedStats->idle === 1,
            'released connection statistics'
        );
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
                    self::unsupportedPrivileges($privileges),
                    'mysql grant, inspect and revoke are unsupported'
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
                self::check(
                    $got['select'] && $got['insert'] && $got['update'] && $got['delete'] && $got['truncate'],
                    'inspectTable'
                );
                self::check(
                    self::code(fn() => $privileges->inspectTable('user')) === Code::CONFIG,
                    'unqualified table'
                );
                self::check(
                    self::code(fn() => $privileges->revokeTable('public.user', 'drop', 'nobody')) === Code::CONFIG,
                    'unsupported privilege'
                );
                $role = 'orm_priv_' . getmypid();
                $table = 'public.privilege_probe';
                $db->pdo()->exec('CREATE TABLE "privilege_probe" ("id" INTEGER)');
                $db->pdo()->exec('CREATE ROLE "' . $role . '"');
                try {
                    $owner = $privileges->inspectTable($table);
                    self::check(
                        $owner['select']
                            && $owner['insert']
                            && $owner['update']
                            && $owner['delete']
                            && $owner['truncate'],
                        'inspectTable reports owner privileges'
                    );
                    $privileges->grantTable($table, $role);
                    $rights = $db->pdo()->prepare(
                        "SELECT has_schema_privilege(?, 'public', 'USAGE'), "
                        . "has_table_privilege(?, 'public.privilege_probe', 'SELECT'), "
                        . "has_table_privilege(?, 'public.privilege_probe', 'INSERT'), "
                        . "has_table_privilege(?, 'public.privilege_probe', 'UPDATE'), "
                        . "has_table_privilege(?, 'public.privilege_probe', 'DELETE')"
                    );
                    $rights->execute([$role, $role, $role, $role, $role]);
                    $granted = array_map(
                        static fn(mixed $value): bool => in_array($value, [true, 1, '1', 't', 'true'], true),
                        $rights->fetch(PDO::FETCH_NUM)
                    );
                    self::check(
                        $granted === [true, true, true, true, true],
                        'grantTable grants schema usage and SELECT, INSERT, UPDATE and DELETE'
                    );
                    $privileges->revokeTable($table, ' select ', $role);
                    $check = $db->pdo()->prepare(
                        "SELECT has_table_privilege(?, 'public.privilege_probe', 'SELECT'), "
                        . "has_table_privilege(?, 'public.privilege_probe', 'INSERT'), "
                        . "has_table_privilege(?, 'public.privilege_probe', 'UPDATE'), "
                        . "has_table_privilege(?, 'public.privilege_probe', 'DELETE')"
                    );
                    $check->execute([$role, $role, $role, $role]);
                    $revoked = array_map(
                        static fn(mixed $value): bool => in_array($value, [true, 1, '1', 't', 'true'], true),
                        $check->fetch(PDO::FETCH_NUM)
                    );
                    self::check($revoked === [false, true, true, true], 'revokeTable removes SELECT only');
                } finally {
                    $db->pdo()->exec('DROP OWNED BY "' . $role . '"');
                    $db->pdo()->exec('DROP ROLE "' . $role . '"');
                    $db->pdo()->exec('DROP TABLE "privilege_probe"');
                }
                break;
            default:
                self::check(!$schema->installed('ormexample', 'user'), 'sqlite schema inspection');
                self::check(
                    self::unsupportedPrivileges($privileges),
                    'sqlite grant, inspect and revoke are unsupported'
                );
        }
    }

    private static function unsupportedPrivileges(\Polyspec\Orm\PrivilegeUtils $privileges): bool
    {
        $codes = [
            self::code(fn() => $privileges->grantTable('public.user', 'orm')),
            self::code(fn() => $privileges->inspectTable('public.user')),
            self::code(fn() => $privileges->revokeTable('public.user', 'SELECT', 'orm')),
        ];
        return $codes === [Code::CAPABILITY_UNSUPPORTED, Code::CAPABILITY_UNSUPPORTED, Code::CAPABILITY_UNSUPPORTED];
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

    // SQLite has no row-lock deadlock. The holder keeps the write lock of an author row while another connection writes
    // it: that write waits for busy_timeout and fails with CANCELED (SQLITE_BUSY). CANCELED is not retried, so the
    // closure runs once, and the holder's commit stands.
    private static function caseSqliteLockedWriterFails(Db $db, string $dsn): void
    {
        $f = self::seed($db);
        $seq = $f['authors'][0]->getSeq();
        $other = \Polyspec\Orm\Tests\Model\connect(
            $dsn,
            new Config(aesKey: 'test-aes-key', blindIndexKey: 'test-blind-key'),
        );
        $runs = 0;
        $blocked = null;
        $db->transaction(function () use ($db, $other, $seq, &$runs, &$blocked): void {
            (new Author())($db)->getBySeq($seq)->setName('holder')->update();
            try {
                $other->transaction(function () use ($other, $seq, &$runs): void {
                    $runs++;
                    (new Author())($other)->getBySeq($seq)->setName('other')->update();
                });
            } catch (OrmException $error) {
                $blocked = $error;
            }
        });
        self::check(
            $blocked !== null && $blocked->code_ === Code::CANCELED,
            'the second writer waits for busy_timeout: ' . ($blocked?->getMessage() ?? 'no error'),
        );
        self::check(
            $runs === 0,
            'CANCELED is not retried: BEGIN waits for busy_timeout, the closure never starts, ran ' . $runs,
        );
        self::check((new Author())($db)->getBySeq($seq)->getName() === 'holder', 'the holder commits its row');
    }

    private static function caseAesRotation(Db $db, string $dsn): void
    {
        $f = self::seed($db);
        $b = (new Author())($db)->getBySeq($f['authors'][0]->getSeq());
        $b->setAesHexEmail('person@example.com')->setAesHexPhone('01012345678')->update();
        self::check((new Author())($db)->aesHexEmail('person@example.com')->getCount() === 1, 'blind index condition');
        $keyring = new AesKeyring([1 => 'test-aes-key', 2 => 'next-aes-key'], 2);
        $status = $db->utils()->aes()->status(new Author(), $keyring);
        self::check(
            $status->current === 2 && $status->total === 4 && $status->pending === 4 && $status->versions === [1 => 4],
            'status',
        );
        self::check($db->utils()->aes()->rotate(new Author(), $keyring) === 4, 'rotate');
        $status = $db->utils()->aes()->status(new Author(), $keyring);
        self::check(
            $status->current === 2 && $status->total === 4 && $status->pending === 0 && $status->versions === [2 => 4],
            'after rotation',
        );
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
        $rotated = (new Author())($current)->getBySeq($f['authors'][0]->getSeq());
        self::check($rotated->getAesHexEmail() === 'person@example.com', 'rotated email uses current key');
        self::check($rotated->getAesHexPhone() === '01012345678', 'rotated phone uses current key');
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

    // The call form of connect on a loaded row and the JSON of a row with its relation are PHP's own (FCV-2).
    // Requirements: DSL-8.
    #[DataProvider('drivers')]
    public function testLoadedRowShortConnectionCall(string $driver): void
    {
        $dsn = self::caseDsn($driver);
        $db = self::database($driver, $dsn);
        self::seed($db);
        $b = (new Author())($db)
            ->relation((new User())->matchUserSeqWithSeq()->aliasWriter())
            ->orderBySeqAsc()->gets()->first();
        self::check($b($db) === $b, 'loaded row short connection call');
        $json = json_decode((string) json_encode($b), true);
        self::check(($json['writer']['name'] ?? null) === 'kim', 'json');
    }

    #[DataProvider('drivers')]
    // Requirements: CFG-4, CFG-5.
    // This no-pool assertion covers INT-92's applicability: the PHP client has
    // no idle pool connection for the server to end. Requirements: CFG-4, INT-92.
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

    // Requirements: INT-55.
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

    // If the MySQL local value reset at the end of the transaction fails, commit and rollback report that error.
    // A MySQL user variable remains after COMMIT and ROLLBACK.
    // (mysql.context.user_variable_session_scope).
    // Requirements: INT-72.
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
    // Requirements: INT-72.
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
    }

    // A PHP request that exits inside a transaction loses its server connection, which rolls back its writes and
    // releases the named lock held by that connection.
    // Requirements: CFG-7.
    public function testRequestExitInsideTransactionRollsBackAndReleasesLock(): void
    {
        $table = 'orm_cfg7_' . bin2hex(random_bytes(8));
        $lock = $table . '.lock';
        $db = Orm::connect(self::$targets['mysql'], new Config());
        try {
            $db->pdo()->exec("CREATE TABLE `$table` (id BIGINT PRIMARY KEY)");
            $process = proc_open(
                [PHP_BINARY, __DIR__ . '/request_termination_child.php', self::$targets['mysql'], $table, $lock],
                [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
                $pipes
            );
            self::assertIsResource($process, 'request child process starts');
            $stdout = stream_get_contents($pipes[1]);
            $stderr = stream_get_contents($pipes[2]);
            fclose($pipes[1]);
            fclose($pipes[2]);
            self::assertSame(0, proc_close($process), "request child exits successfully: $stdout $stderr");

            self::assertSame(
                0,
                (int) $db->pdo()->query("SELECT COUNT(*) FROM `$table`")->fetchColumn(),
                'exit rolls back',
            );
            self::assertSame(
                1,
                (int) $db->pdo()->query('SELECT GET_LOCK(' . $db->pdo()->quote($lock) . ', 0)')->fetchColumn(),
                'exit releases lock',
            );
            $db->pdo()->query('SELECT RELEASE_LOCK(' . $db->pdo()->quote($lock) . ')')->fetchColumn();
        } finally {
            $db->pdo()->exec("DROP TABLE IF EXISTS `$table`");
            $db->close();
        }
    }

    // PostgreSQL receives the UTC time zone and statement timeout as client startup parameters.
    // Requirements: CFG-7.
    public function testPostgresSessionSettingsAreStartupParameters(): void
    {
        PostgresSessionSettings::assertStartupParameters(self::$targets['postgres']);
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
    // Requirements: PLN-6, PLN-7, PLN-16, PLN-23, PLN-28, PLN-29, PLN-34, PLN-36, PLN-37, PLN-38, PLN-39.
    #[DataProvider('drivers')]
    // Requirements: DSL-49, DSL-50, DSL-60, PLN-4.
    public function testConditions(string $driver): void
    {
        $dsn = self::caseDsn($driver);
        $db = self::database($driver, $dsn);
        self::caseConditions($db, $dsn);
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
    // Requirements: DSL-115, DSL-155, PLN-12, PLN-27.
    #[DataProvider('drivers')]
    public function testWrites(string $driver): void
    {
        // The test of DSL-107, DSL-116 (docs/spec).
        $dsn = self::caseDsn($driver);
        $db = self::database($driver, $dsn);
        self::caseWrites($db, $dsn);
    }

    // styled value states
    // Requirements: COD-20.
    #[DataProvider('drivers')]
    public function testStyledValueStates(string $driver): void
    {
        $dsn = self::caseDsn($driver);
        $db = self::database($driver, $dsn);
        self::caseStyledValueStates($db);
    }


    // transactions
    // Requirements: PLN-13, PLN-16, PLN-17, PLN-20, PLN-21, INT-51, INT-61, INT-73, INT-134, INT-79.
    #[DataProvider('drivers')]
    public function testTransactions(string $driver): void
    {
        // The test of DSL-118, DSL-119, DSL-123, DSL-125, DSL-126 (docs/spec).
        $dsn = self::caseDsn($driver);
        $db = self::database($driver, $dsn);
        self::caseTransactions($db, $dsn);
    }

    // utilities
    // Requirements: INT-55, INT-57, INT-59.
    #[DataProvider('drivers')]
    public function testUtilities(string $driver): void
    {
        $dsn = self::caseDsn($driver);
        $db = self::database($driver, $dsn);
        self::caseUtilities($db, $dsn);
    }

    // deadlock retry. SQLite has no row-lock deadlock, so it runs the sequential case of a locked writer instead.
    // Requirements: PLN-24.
    #[DataProvider('drivers')]
    public function testDeadlockRetry(string $driver): void
    {
        $dsn = self::caseDsn($driver);
        $db = self::database($driver, $dsn);
        if ($driver === 'sqlite') {
            self::caseSqliteLockedWriterFails($db, $dsn);
            return;
        }
        self::caseDeadlockRetry($db, $dsn);
    }

    // bind limit splitting
    // Requirements: PRT-41, PRT-76.
    #[DataProvider('drivers')]
    public function testBindLimitSplitting(string $driver): void
    {
        $dsn = self::caseDsn($driver);
        $db = self::database($driver, $dsn);
        self::caseBindLimitSplitting($db, $dsn);
    }
}
