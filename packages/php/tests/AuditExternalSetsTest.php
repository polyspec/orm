<?php

declare(strict_types=1);

// Audit transactions over sets registered by schema value, on SQLite, MySQL and PostgreSQL
// (contracts/fixtures/external). core owns ext_account and ext_audit; board and member each use
// them and own an audited table that records its audits in ext_audit. core and board are
// registered by their schema value only, so the process loads no generated class of them: their
// runtime model comes from the manifest text and the external text. member is generated and
// loaded, after its installation by value in one order and before it in the other. Registry is
// process-global, so every order and database runs in a process of its own: PHPUnit runs each
// test in a separate process (RunTestsInSeparateProcesses). Each test uses a case database of its own
// (case_database.php); the test fails when ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN is unset.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/AuditExternalSetsTest.php
require_once __DIR__ . '/case_database.php';

use Polyspec\Orm\Config;
use Polyspec\Orm\Generator;
use Polyspec\Orm\Orm;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Schema;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\Attributes\RunTestsInSeparateProcesses;
use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\DataProvider;

#[Medium]
#[RunTestsInSeparateProcesses]
final class AuditExternalSetsTest extends TestCase
{
    private static mixed $root = null;

    /** The fixture of the file: what the script did before its cases, once per class. */
    private static function fixture(): void
    {
        self::$root = dirname(__DIR__, 3);
    }

    /** Creates the schema value of the set in contracts/fixtures/external. No generated class is made. */
    private static function valueSchema(array $owned, array $external): Schema
    {
        $path = static fn(string $name): string => self::$root . "/contracts/fixtures/external/$name.dbs";
        $m = RuntimeModel::build(RuntimeModel::files(array_map($path, $owned), array_map($path, $external)));
        return new Schema($m->manifestText, $m->manifestHash, $m->externalText);
    }

    /** Creates the model of the member set in $work. The caller requires the bootstrap. */
    private static function generateMember(string $work): void
    {
        $path = static fn(string $name): string => self::$root . "/contracts/fixtures/external/$name.dbs";
        Generator::generate(RuntimeModel::build(RuntimeModel::files([$path('member')], [$path('core')])), "$work/member", 'Polyspec\\Orm\\Tests\\AuditExternalSets\\Member');
        spl_autoload_register(static function (string $class) use ($work): void {
            $prefix = 'Polyspec\\Orm\\Tests\\AuditExternalSets\\Member\\';
            if (str_starts_with($class, $prefix)) {
                require "$work/member/" . substr($class, strlen($prefix)) . '.php';
            }
        });
    }

    private static function want(bool $ok, string $message): void
    {
        \PHPUnit\Framework\Assert::assertTrue($ok, $message);
    }

    /**
     * Installs core and board only as schema values, creates and reads member, installs it, and checks whether the audit transaction of member
     * writes to ext_audit, owned by core, and keeps that key in ext_post_history. member_by_value_first
     * also installs member first as schema values, and then reads the generated bootstrap.
     */
    private static function scenario(string $order, string $dsn, string $work): void
    {
        $db = Orm::connect($dsn, new Config(auditSource: static fn(): array => ['actor' => 'writer']));
        try {
            $schema = $db->utils()->schema();
            $schema->install(self::valueSchema(['core'], []));
            $schema->install(self::valueSchema(['board'], ['core']));
            $db->pdo()->exec("INSERT INTO ext_account (name) VALUES ('kim')");
            self::generateMember($work);
            if ($order === 'member_by_value_first') {
                $schema->install(self::valueSchema(['member'], ['core']));
                require "$work/member/bootstrap.php";
            } else {
                require "$work/member/bootstrap.php";
                $schema->install(\Polyspec\Orm\Tests\AuditExternalSets\Member\schema());
            }
            $db->transaction(fn() => (new \Polyspec\Orm\Tests\AuditExternalSets\Member\ExtPost())($db)->setAccountSeq(1)->setTitle('hello')->create(), audit: []);
            $records = $db->pdo()->query('SELECT seq, actor FROM ext_audit ORDER BY seq')->fetchAll(PDO::FETCH_NUM);
            self::want(count($records) === 1 && $records[0][1] === 'writer', 'ext_audit ' . json_encode($records) . ', want one record of writer');
            $recorded = $db->pdo()->query('SELECT audit_seq FROM ext_post_history')->fetchAll(PDO::FETCH_COLUMN);
            self::want(count($recorded) === 1 && (int) $recorded[0] === (int) $records[0][0], 'ext_post_history audit keys ' . json_encode($recorded) . ", want [{$records[0][0]}]");
        } finally {
            $db->close();
        }
    }

    public static function setUpBeforeClass(): void
    {
        self::fixture();
    }

    /** @return iterable<string, array{string}> */
    public static function drivers(): iterable
    {
        foreach (['sqlite', 'mysql', 'postgres'] as $driver) {
            yield $driver => [$driver];
        }
    }

    /** Runs the order on a case database of the driver with a work directory of its own, removed on every path. */
    private static function runOrder(string $order, string $driver): void
    {
        $work = sys_get_temp_dir() . '/orm-php-audit-external-sets-' . getmypid();
        if (!mkdir($work, 0o700, true)) {
            throw new RuntimeException("cannot create $work");
        }
        try {
            with_case_database($driver, static function (string $step): void {
            }, static fn(string $dsn) => self::scenario($order, $dsn, $work));
        } finally {
            exec('rm -rf ' . escapeshellarg($work));
        }
    }

    // Requirements: DBS-110, SCH-11, SCH-12.
    #[DataProvider('drivers')]
    public function test_generated_after_values(string $driver): void
    {
        self::runOrder('generated_after_values', $driver);
    }

    // Requirements: DBS-110, SCH-11, SCH-12.
    #[DataProvider('drivers')]
    public function test_member_by_value_first(string $driver): void
    {
        self::runOrder('member_by_value_first', $driver);
    }
}
