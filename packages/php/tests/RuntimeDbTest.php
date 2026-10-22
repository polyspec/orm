<?php

declare(strict_types=1);

// Runtime model behavior on SQLite, MySQL and PostgreSQL (docs/spec/dbspec.md
// "Runtime model" and "Audit"): installing a dbspec document set, i16, uuid,
// date and time values, database defaults for omitted columns, the required
// column rule, the audit record of a transaction, and the restore of
// soft-deleted rows. The models of contracts/fixtures/audit.dbs with a values
// document and of contracts/fixtures/restore.dbs are generated into a temporary
// directory as two document sets, because both fixtures declare the table audit,
// so the test runs in its own process.
// Each case runs in a case database of its own (case_database.php) created
// through ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN; the test fails when either
// is unset.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/RuntimeDbTest.php
// [--filter <case>] The bench model is not read: this test uses only the model of its own document set.
require_once __DIR__ . '/case_database.php';
require_once __DIR__ . '/restore_case.php';
require_once __DIR__ . '/audit_case.php';

use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Generator;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Tests\RuntimeDb\Item;
use Polyspec\Orm\Tests\RuntimeDb\Sample;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\DataProvider;

#[Medium]
final class RuntimeDbTest extends TestCase
{
    /** The fixture of the file: what the script did before its cases, once per class. */
    private static function fixture(): void
    {
        $root = dirname(__DIR__, 3);
        $work = sys_get_temp_dir() . '/orm-php-runtime-db-' . getmypid();
        @mkdir($work, 0o700, true);
        register_shutdown_function(static function () use ($work): void {
            exec('rm -rf ' . escapeshellarg($work));
        });

        $values = "dbspec 1 runtime_values\n\ntable sample {\n  seq i64 identity\n  level i16\n  amount i32 default 7\n  label varchar(16) default 'x'\n"
            . "  note text null\n  day date null\n  clock time(3) null\n  created datetime(6) default now\n  token uuid null\n  primary key (seq)\n}\n";
        // audit.dbs and restore.dbs both declare an audit table, so each is generated separately and only one is
        // installed per case.
        $sets = [
            'Polyspec\\Orm\\Tests\\RuntimeDb' => [
                'audit.dbs' => (string) file_get_contents("$root/contracts/fixtures/audit.dbs"),
                'values.dbs' => $values
            ],
            // The runtime restore is its own manifest: the coverage restore of the same fixture is generated in this
            // process too, and the registry refuses one manifest under two namespaces, so the header names this
            // manifest apart.
            'Polyspec\\Orm\\Tests\\RuntimeRestore' => [
                'restore.dbs' => str_replace(
                    "dbspec 1 restore\n",
                    "dbspec 1 runtime_restore\n",
                    (string) file_get_contents("$root/contracts/fixtures/restore.dbs")
                )
            ],
        ];
        foreach ($sets as $namespace => $texts) {
            $dir = "$work/" . str_replace('\\', '_', $namespace);
            Generator::generate(RuntimeModel::build(RuntimeModel::parse($texts)), $dir, $namespace);
            spl_autoload_register(static function (string $class) use ($dir, $namespace): void {
                if (str_starts_with($class, "$namespace\\")) {
                    require "$dir/" . substr($class, strlen("$namespace\\")) . '.php';
                }
            });
            require "$dir/bootstrap.php";
        }
    }

    private static function want(bool $ok, string $message): void
    {
        \PHPUnit\Framework\Assert::assertTrue($ok, $message);
    }

    private static function errorCode(Closure $fn): string
    {
        try {
            $fn();
        } catch (OrmException $e) {
            return $e->code_;
        }
        return 'no error';
    }

    /**
     * Connects with dsn, using the audit source that gives 'default' as the audit value, and installs the document set
     * of $namespace.
     */
    private static function database(string $dsn, string $namespace): Db
    {
        $db = Orm::connect($dsn, auditConfig('default'));
        $db->utils()->schema()->install(("$namespace\\schema")());
        return $db;
    }

    private static function case_install_renders_the_document_set(Db $db): void
    {
        $count = static fn(string $table): int => (int) $db->pdo()->query("SELECT COUNT(*) FROM $table")->fetchColumn();
        self::want($count('item') === 0 && $count('item_history') === 0 && $count('sample') === 0, 'installed tables');
        $db->utils()->schema()->install(\Polyspec\Orm\Tests\RuntimeDb\schema());
        self::want($count('sample') === 0, 'a repeated install');
    }

    private static function case_i16_values_and_defaults(Db $db): void
    {
        $low = (new Sample())($db)->setLevel(-32768)->create();
        $high = (new Sample())($db)->setLevel(32767)->setNote('n')->setToken('0f8fad5b-d9cb-469f-a165-70867728950e')
            ->setDay('2026-02-03')->setClock('12:34:56.789')->create();
        $row = (new Sample())($db)->getBySeq($low->getSeq());
        self::want($row->getLevel() === -32768, 'i16 low ' . var_export($row->getLevel(), true));
        self::want($row->getAmount() === 7 && $row->getLabel() === 'x', 'database defaults');
        self::want(
            abs($row->getCreated()->getTimestamp() - time()) < 60 && $row->getCreated()->getOffset() === 0,
            'now default in UTC'
        );
        self::want($row->getNote() === null && $row->getToken() === null, 'null columns');
        $row = (new Sample())($db)->getBySeq($high->getSeq());
        self::want(
            $row->getLevel() === 32767 && $row->getToken() === '0f8fad5b-d9cb-469f-a165-70867728950e',
            'i16 high and uuid'
        );
        self::want(
            $row->getDay()->format('Y-m-d') === '2026-02-03' && $row->getClock() === '12:34:56.789',
            'date and time'
        );
        self::want(
            (new Sample())($db)->level(32767)->getCount() === 1 && (new Sample())($db)->ltLevel(0)->getCount() === 1,
            'i16 conditions'
        );
        self::want(
            (new Sample())($db)->token('0f8fad5b-d9cb-469f-a165-70867728950e')->getCount() === 1,
            'uuid condition'
        );
        self::want(
            self::errorCode(fn() => (new Sample())($db)->setAmount(1)->create()) === Code::IR_INVALID,
            'an omitted non-null column without a default'
        );
        self::want((new Sample())($db)->getCount() === 2, 'the rejected insert stays out of the database');
    }

    // An audit transaction inserts one audit record, and the write to the audit table writes its key (audit_case.php).
    private static function case_audit_record_of_a_transaction(Db $db, string $dsn): void
    {
        auditCase($db, $dsn, 'Polyspec\\Orm\\Tests\\RuntimeDb');
        $assigned = self::errorCode(
            fn() => $db->transaction(fn() => (new Item())->setTitle('a')->setAuditSeq(1)->create(), audit: [], retry: 0)
        );
        self::want($assigned === Code::IR_INVALID, "an assigned audit column = $assigned, want IR_INVALID");
        self::want((new Item())($db)->getCount() === 0, 'soft delete hides the row');
    }

    // restore returns a soft-deleted row by its primary key or unique key (restore_case.php).
    private static function case_restore_of_soft_deleted_rows(Db $db): void
    {
        restoreCase($db, 'Polyspec\\Orm\\Tests\\RuntimeRestore');
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

    /**
     * Each case installs its document set in a case database of its own, writes and reads a few rows and removes the
     * database.
     */
    private static function runCase(string $driver, string $namespace, Closure $case): void
    {
        with_case_database($driver, static function (string $step): void {
        }, static function (string $dsn) use ($namespace, $case): void {
            $db = self::database($dsn, $namespace);
            try {
                $case($db, $dsn);
            } finally {
                $db->close();
            }
        });
    }

    // Requirements: DBS-108, SCH-7.
    #[DataProvider('drivers')]
    public function test_install_renders_the_document_set(string $driver): void
    {
        self::runCase($driver, 'Polyspec\\Orm\\Tests\\RuntimeDb', self::case_install_renders_the_document_set(...));
    }

    #[DataProvider('drivers')]
    public function test_i16_values_and_defaults(string $driver): void
    {
        self::runCase($driver, 'Polyspec\\Orm\\Tests\\RuntimeDb', self::case_i16_values_and_defaults(...));
    }

    #[DataProvider('drivers')]
    public function test_audit_record_of_a_transaction(string $driver): void
    {
        self::runCase($driver, 'Polyspec\\Orm\\Tests\\RuntimeDb', self::case_audit_record_of_a_transaction(...));
    }

    #[DataProvider('drivers')]
    public function test_restore_of_soft_deleted_rows(string $driver): void
    {
        self::runCase($driver, 'Polyspec\\Orm\\Tests\\RuntimeRestore', self::case_restore_of_soft_deleted_rows(...));
    }
}
