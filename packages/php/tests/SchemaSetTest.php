<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// Several dbspec document sets in one process, on SQLite, MySQL and
// PostgreSQL. The generated bench models (packages/php/gen) and the models of
// contracts/fixtures/decimal_schema.dbs, generated into their own namespace,
// are loaded together; each model class carries the manifestHash of its own
// set. A connection plans only the sets registered on it: the connect helper
// of generated code and install register a set, and a raw connection
// registers none. A request of a set that is not registered on its connection
// fails with SCHEMA_HASH_MISMATCH before execution, also when another
// connection installed the set. A manifest text that does not hash to its
// declared manifestHash fails with CONFIG when it is connected or installed,
// and generated code of such a text fails with SCHEMA_HASH_MISMATCH when it
// loads. Each case runs in a case database of its own (case_database.php: a
// new SQLite file, or a database the case creates on the server of
// ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN); the test fails when either
// variable is unset.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/SchemaSetTest.php
// [--filter <case>]

use DateTimeZone;
use Polyspec\Orm\Tests\Model\User;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Schema;
use Polyspec\Orm\Tests\SchemaSetDecimal\DecimalCase;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\DataProvider;

#[Medium]
final class SchemaSetTest extends TestCase
{
    use ThreeDrivers;

    private static mixed $work = null;
    private static mixed $decimalDocuments = null;
    private static mixed $decimalModel = null;

    /** The fixture of the file: what the script did before its cases, once per class. */
    private static function fixture(): void
    {
        self::$work = sys_get_temp_dir() . '/orm-php-schema-set-' . getmypid();
        is_dir(self::$work) || mkdir(self::$work, 0o700, true);
        register_shutdown_function(static function (): void {
            exec('rm -rf ' . escapeshellarg(self::$work));
        });

        // The schema set has its own manifest header: the decimal fixture of DecimalModelDbTest is generated in this
        // process too, and the registry refuses one manifest under two namespaces.
        self::$decimalDocuments = [
            str_replace(
                "dbspec 1 decimal_schema\n",
                "dbspec 1 schema_set_decimal\n",
                (string) file_get_contents(\coverageRepositoryRoot() . "/contracts/fixtures/decimal_schema.dbs")
            )
        ];
        self::$decimalModel = RuntimeModel::build(
            RuntimeModel::parse(['decimal_schema.dbs' => self::$decimalDocuments[0]])
        );
        generateModels(
            ['decimal_schema.dbs' => self::$decimalDocuments[0]],
            self::$work . "/decimal-source",
            self::$work . "/decimal",
            'Polyspec\\Orm\\Tests\\SchemaSetDecimal'
        );
        requireGeneratedClasses(self::$work . "/decimal");
        require self::$work . "/decimal/bootstrap.php";
    }


    private static function check(bool $ok, string $message): void
    {
        \PHPUnit\Framework\Assert::assertTrue($ok, $message);
    }

    /** The code of the OrmException that the call threw. An empty string if there was no error. */
    private static function code(callable $f): string
    {
        try {
            $f();
        } catch (OrmException $e) {
            return $e->code_;
        }
        return '';
    }

    /** Registers a subscriber that counts the statements the connection sends into $n, and returns that connection. */
    private static function counted(Db $db, int &$n): Db
    {
        $db->subscribe(static function () use (&$n): void {
            $n++;
        });
        return $db;
    }

    /**
     * Generated code of a manifest text edited under its declared hash fails with SCHEMA_HASH_MISMATCH when it is loaded
     * (DBS-120). The connect and install of such a text are cases of the statement_events recipe.
     */
    private static function editedManifest(): void
    {
        static $edits = 0;
        // The generated code of the edited text declares the hash of the real decimal set.
        $editedText = str_replace('decimal(13,4)', 'decimal(14,4)', self::$decimalDocuments[0]);
        $editedModel = RuntimeModel::build(RuntimeModel::parse(['decimal_schema.dbs' => $editedText]));
        $namespace = 'SchemaSetEdited' . (++$edits) . '\\Orm';
        $dir = self::$work . "/edited-$edits";
        generateModels(
            ['decimal_schema.dbs' => $editedText],
            self::$work . "/edited-$edits-source",
            $dir,
            $namespace
        );
        foreach (glob("$dir/*.php") as $file) {
            file_put_contents(
                $file,
                str_replace(
                    $editedModel->manifestHash,
                    self::$decimalModel->manifestHash,
                    (string) file_get_contents($file)
                )
            );
        }
        self::check(self::code(function () use ($dir): void {
            require "$dir/bootstrap.php";
        }) === Code::SCHEMA_HASH_MISMATCH, 'loading generated code of an edited manifest');
    }

    /**
     * Creates the set of contracts/fixtures/external and returns its schema values (once per process). core
     * owns ext_core. member uses ext_core's ext_account and ext_audit as use, and owns only ext_post and
     * ext_post_history; member_v2 adds a summary column, and drifted uses core_extra (a column nick that is not in the
     * database) as an external document.
     *
     * @return array{core: Schema, member: Schema, memberV2: Schema, drifted: Schema}
     */
    private static function externalSets(): array
    {
        static $sets = null;
        if ($sets !== null) {
            return $sets;
        }
        $fixture = static fn(string $name): string => \coverageRepositoryRoot()
            . "/contracts/fixtures/external/$name.dbs";
        $read = static function (array $names) use ($fixture): array {
            $texts = [];
            foreach ($names as $name) {
                $texts["$name.dbs"] = (string) file_get_contents($fixture($name));
            }
            return $texts;
        };
        $built = [];
        foreach (
            [
            'core' => ['ExtCore', ['core'], []],
            'member' => ['ExtMember', ['member'], ['core']],
            'memberV2' => ['ExtMemberV2', ['member_v2'], ['core']],
            'drifted' => ['ExtDrifted', ['member'], ['core_extra']],
            ] as $key => [$prefix, $owned, $external]
        ) {
            $namespace = "Polyspec\\Orm\\Tests\\$prefix";
            generateModels(
                $read($owned),
                self::$work . "/$prefix-source",
                self::$work . "/$prefix",
                $namespace,
                $read($external)
            );
            requireGeneratedClasses(self::$work . "/$prefix");
            require self::$work . "/$prefix/bootstrap.php";
            $built[$key] = ("$namespace\\schema")();
        }
        return $sets = $built;
    }

    /**
     * Registration sends no statement to the database (docs/spec/schema.md "Schema registration").
     * On a connection opened with StatementCountingPdo, register does not read the database, even for a set that uses
     * external documents, and text that does not hash to the declared hash is CONFIG with no statement. A request for a
     * registered bench set runs on that connection. connectSchema sends only the statements that connect sends.
     */
    private static function registerSendsNoStatement(string $dsn): void
    {
        ['member' => $member] = self::externalSets();
        $installer = Orm::connect($dsn, new Config());
        try {
            \Polyspec\Orm\Tests\installBench($installer);
        } finally {
            $installer->close();
        }
        [$driver, $pdoDsn, $user, $password] = Orm::parseDsn($dsn);
        $pdo = new StatementCountingPdo($pdoDsn, $user, $password);
        $db = new \Polyspec\Orm\Db($pdo, $driver, new Config(), new DateTimeZone('UTC'));
        try {
            self::check(
                self::code(fn() => (new User())($db)->getCount()) === Code::SCHEMA_HASH_MISMATCH,
                'bench read before the register'
            );
            $before = $pdo->sent;
            $db->utils()->schema()->register(\Polyspec\Orm\Tests\Model\schema());
            $db->utils()->schema()->register(\Polyspec\Orm\Tests\Model\schema());
            $db->utils()->schema()->register($member);
            $bench = \Polyspec\Orm\Tests\Model\schema();
            $edited = new Schema($bench->manifestText . "\n", $bench->manifestHash);
            self::check(
                self::code(fn() => $db->utils()->schema()->register($edited)) === Code::CONFIG,
                'register of a text that does not hash to its declared hash'
            );
            $sent = $pdo->sent - $before;
            self::check($sent === 0, "register sent $sent statements, want 0");
            $users = (new User())($db)->getCount();
            self::check($users === 0, "bench read after the register: $users rows");
        } finally {
            $db->close();
        }
        $runs = 0;
        self::counted(Orm::connect($dsn, new Config()), $runs)->close();
        $connectRuns = $runs;
        $runs = 0;
        self::counted(Orm::connectSchema($dsn, $member, new Config()), $runs)->close();
        self::check($runs === $connectRuns, "connectSchema ran $runs statements, connect $connectRuns");
    }

    public static function setUpBeforeClass(): void
    {
        self::fixture();
    }

    // Requirements: DBS-120.
    public function testEditedManifest(): void
    {
        self::editedManifest();
    }
}
