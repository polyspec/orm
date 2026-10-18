<?php
declare(strict_types=1);
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
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/SchemaSetTest.php [--filter <case>]
require_once __DIR__ . '/case_database.php';

use Polyspec\Orm\Tests\Model\User;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Generator;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Schema;
use Polyspec\Orm\Tests\SchemaSetDecimal\DecimalCase;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\DataProvider;

/** Counts all statements, prepares, and transaction starts that the connection sends to the database. */
final class StatementCountingPdo extends PDO
{
    public int $sent = 0;

    public function exec(string $statement): int|false
    {
        $this->sent++;
        return parent::exec($statement);
    }

    public function query(string $query, ?int $fetchMode = null, mixed ...$fetchModeArgs): PDOStatement|false
    {
        $this->sent++;
        return parent::query($query, $fetchMode, ...$fetchModeArgs);
    }

    public function prepare(string $query, array $options = []): PDOStatement|false
    {
        $this->sent++;
        return parent::prepare($query, $options);
    }

    public function beginTransaction(): bool
    {
        $this->sent++;
        return parent::beginTransaction();
    }
}

#[Medium]
final class SchemaSetTest extends TestCase
{
    private static mixed $work = null;
    private static mixed $decimalDocuments = null;
    private static mixed $decimalModel = null;
    private static mixed $root = null;

    /** The fixture of the file: what the script did before its cases, once per class. */
    private static function fixture(): void
    {
        self::$root = dirname(__DIR__, 3);
        self::$work = sys_get_temp_dir() . '/orm-php-schema-set-' . getmypid();
        @mkdir(self::$work, 0o700, true);
        register_shutdown_function(static function (): void {
            exec('rm -rf ' . escapeshellarg(self::$work));
        });

        // The schema set has its own manifest header: the decimal fixture of DecimalModelDbTest is generated in this process too,
        // and the registry refuses one manifest under two namespaces.
        self::$decimalDocuments = [str_replace("dbspec 1 decimal_schema\n", "dbspec 1 schema_set_decimal\n", (string) file_get_contents(self::$root . "/contracts/fixtures/decimal_schema.dbs"))];
        self::$decimalModel = RuntimeModel::build(RuntimeModel::parse(['decimal_schema.dbs' => self::$decimalDocuments[0]]));
        Generator::generate(self::$decimalModel, self::$work . "/decimal", 'Polyspec\\Orm\\Tests\\SchemaSetDecimal');
        self::autoload(self::$work . "/decimal", 'Polyspec\\Orm\\Tests\\SchemaSetDecimal');
        require self::$work . "/decimal/bootstrap.php";
    }

    /** Registers an autoloader that reads the classes of $namespace from the generated file in $dir. */
    private static function autoload(string $dir, string $namespace): void
    {
        spl_autoload_register(static function (string $class) use ($dir, $namespace): void {
            if (str_starts_with($class, "$namespace\\")) {
                require "$dir/" . substr($class, strlen($namespace) + 1) . '.php';
            }
        });
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

    /**
     * The connection opened with the bench helper installs the bench and decimal sets (decimal twice,
     * and the second install changes nothing), and uses the models of both sets inside and outside a transaction.
     */
    private static function severalSchemas(string $dsn): void
    {
        $db = \Polyspec\Orm\Tests\Model\connect($dsn, new Config());
        try {
            foreach ([\Polyspec\Orm\Tests\Model\schema(), \Polyspec\Orm\Tests\SchemaSetDecimal\schema(), \Polyspec\Orm\Tests\SchemaSetDecimal\schema()] as $schema) {
                $db->utils()->schema()->install($schema);
            }
            (new User)($db)->setName('core')->create();
            (new DecimalCase)($db)->setSeq(1)->setAmount('48.0450')->create();
            $db->transaction(function (): void {
                (new User)->setName('core-tx')->create();
                (new DecimalCase)->setSeq(2)->setAmount('1.5000')->create();
            }, retry: 0);
            $users = (new User)($db)->getCount();
            self::check($users === 2, "core rows $users");
            $amount = (new DecimalCase)($db)->addAllColumns()->getBySeq(1)->getAmount();
            self::check($amount === '48.0450', "decimal amount $amount");
            $decimals = (new DecimalCase)($db)->getCount();
            self::check($decimals === 2, "decimal rows $decimals");
        } finally {
            $db->close();
        }
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
     * A request for a set that is not registered on the connection fails before it runs with
     * SCHEMA_HASH_MISMATCH, even if the table exists. A raw connection registers no set, and a connection opened with the bench helper
     * does not register the decimal set that another connection installed. A connection opened with the decimal helper
     * uses that set.
     */
    private static function unregisteredSchema(string $dsn): void
    {
        $runs = 0;
        $raw = self::counted(Orm::connect($dsn, new Config()), $runs);
        try {
            self::check(self::code(fn() => (new User)($raw)->getCount()) === Code::SCHEMA_HASH_MISMATCH, 'bench read on a raw connection');
        } finally {
            $raw->close();
        }
        $core = self::counted(\Polyspec\Orm\Tests\Model\connect($dsn, new Config()), $runs);
        try {
            $installer = \Polyspec\Orm\Tests\SchemaSetDecimal\connect($dsn, new Config());
            try {
                $installer->utils()->schema()->install(\Polyspec\Orm\Tests\SchemaSetDecimal\schema());
                (new DecimalCase)($installer)->setSeq(1)->setAmount('1.0000')->create();
            } finally {
                $installer->close();
            }
            self::check(self::code(fn() => (new DecimalCase)($core)->getCount()) === Code::SCHEMA_HASH_MISMATCH, 'decimal read on the bench connection');
            self::check(self::code(fn() => (new DecimalCase)($core)->setSeq(2)->setAmount('2.0000')->create()) === Code::SCHEMA_HASH_MISMATCH, 'decimal write on the bench connection');
            self::check($runs === 0, "unregistered requests ran $runs statements");
        } finally {
            $core->close();
        }
        $decimal = \Polyspec\Orm\Tests\SchemaSetDecimal\connect($dsn, new Config());
        try {
            $rows = (new DecimalCase)($decimal)->getCount();
            self::check($rows === 1, "decimal rows through the decimal helper $rows");
        } finally {
            $decimal->close();
        }
    }

    /**
     * The connect and install of a schema whose manifest text does not hash to the declared manifestHash
     * are CONFIG before any statement and do not change the tables. Generated code
     * in such text fails with SCHEMA_HASH_MISMATCH when it is loaded.
     */
    private static function editedManifest(string $dsn): void
    {
        static $edits = 0;
        $edited = new Schema(str_replace('decimal(13,4)', 'decimal(14,4)', self::$decimalModel->manifestText), self::$decimalModel->manifestHash);
        self::check($edited->manifestText !== self::$decimalModel->manifestText, 'edited manifest differs');
        self::check(self::code(fn() => Orm::connectSchema($dsn, $edited, new Config())) === Code::CONFIG, 'connect with an edited manifest');
        $runs = 0;
        $db = self::counted(\Polyspec\Orm\Tests\SchemaSetDecimal\connect($dsn, new Config()), $runs);
        try {
            self::check(self::code(fn() => $db->utils()->schema()->install($edited)) === Code::CONFIG, 'install of an edited manifest');
            self::check($runs === 0, "the edited install ran $runs statements");
            $db->utils()->schema()->install(\Polyspec\Orm\Tests\SchemaSetDecimal\schema());
            self::check((new DecimalCase)($db)->getCount() === 0, 'decimal read');
            // The generated code of the edited text declares the hash of the real decimal set.
            $editedModel = RuntimeModel::build(RuntimeModel::parse(['decimal_schema.dbs' => str_replace('decimal(13,4)', 'decimal(14,4)', self::$decimalDocuments[0])]));
            $namespace = 'SchemaSetEdited' . (++$edits) . '\\Orm';
            $dir = self::$work . "/edited-$edits";
            Generator::generate($editedModel, $dir, $namespace);
            foreach (glob("$dir/*.php") as $file) {
                file_put_contents($file, str_replace($editedModel->manifestHash, self::$decimalModel->manifestHash, (string) file_get_contents($file)));
            }
            self::check(self::code(function () use ($dir): void {
                require "$dir/bootstrap.php";
            }) === Code::SCHEMA_HASH_MISMATCH, 'loading generated code of an edited manifest');
            [$driver] = Orm::parseDsn($dsn);
            $type = match ($driver) {
                'mysql' => $db->pdo()->query("SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'decimal_case' AND COLUMN_NAME = 'amount'")->fetchColumn(),
                'postgres' => $db->pdo()->query("SELECT numeric_precision || ',' || numeric_scale FROM information_schema.columns WHERE table_name = 'decimal_case' AND column_name = 'amount'")->fetchColumn(),
                default => $db->pdo()->query("SELECT sql FROM sqlite_master WHERE name = 'decimal_case'")->fetchColumn(),
            };
            $unchanged = match ($driver) {
                'mysql' => $type === 'decimal(13,4)',
                'postgres' => $type === '13,4',
                default => is_string($type) && str_contains($type, '"amount"') && !str_contains($type, '14'),
            };
            self::check($unchanged, 'decimal_case.amount is unchanged: ' . var_export($type, true));
        } finally {
            $db->close();
        }
    }

    /**
     * Creates the set of contracts/fixtures/external and returns its schema values (once per process). core
     * owns ext_core. member uses ext_core's ext_account and ext_audit as use, and owns only ext_post and
     * ext_post_history; member_v2 adds a summary column, and drifted uses core_extra (a column nick that is not in the database)
     * as an external document.
     *
     * @return array{core: Schema, member: Schema, memberV2: Schema, drifted: Schema}
     */
    private static function externalSets(): array
    {
        static $sets = null;
        if ($sets !== null) {
            return $sets;
        }
        $fixture = static fn(string $name): string => self::$root . "/contracts/fixtures/external/$name.dbs";
        $built = [];
        foreach ([
            'core' => ['ExtCore', ['core'], []],
            'member' => ['ExtMember', ['member'], ['core']],
            'memberV2' => ['ExtMemberV2', ['member_v2'], ['core']],
            'drifted' => ['ExtDrifted', ['member'], ['core_extra']],
        ] as $key => [$prefix, $owned, $external]) {
            $model = RuntimeModel::build(RuntimeModel::files(array_map($fixture, $owned), array_map($fixture, $external)));
            $namespace = "Polyspec\\Orm\\Tests\\$prefix";
            Generator::generate($model, self::$work . "/$prefix", $namespace);
            self::autoload(self::$work . "/$prefix", $namespace);
            require self::$work . "/$prefix/bootstrap.php";
            $built[$key] = ("$namespace\\schema")();
        }
        return $sets = $built;
    }

    /**
     * Checks, on the database at dsn, the set that uses external documents (contracts/fixtures/external)
     * (same as externalCase in packages/go/orm/external_documents_test.go).
     *   - If an external table is missing, install and addTablesAndColumns are CONFIG before any statement and
     *     do not create member's table. Registration does not read the database, so connectSchema connects even if
     *     the external table is missing or different.
     *   - After core is installed, the member install creates only the tables it owns, and running it again changes nothing.
     *     addTablesAndColumns adds columns only to the tables it owns.
     *   - member's audit transaction inserts the record into ext_audit, which core owns.
     *   - If the write table of an external document differs from the database (a missing column), it is CONFIG.
     */
    private static function externalDocuments(string $dsn): void
    {
        ['core' => $core, 'member' => $member, 'memberV2' => $memberV2, 'drifted' => $drifted] = self::externalSets();
        $config = new Config(auditSource: static fn(): array => ['actor' => 'writer']);
        $expectConfig = static function (string $step, callable $f, string $message): void {
            try {
                $f();
                self::check(false, "$step: no error, want CONFIG with $message");
            } catch (OrmException $e) {
                self::check($e->code_ === Code::CONFIG && str_contains($e->getMessage(), $message), "$step: {$e->code_} {$e->getMessage()}, want CONFIG with $message");
            }
        };
        $missing = 'the tables that the set uses from external documents differ from the database: table ext_account does not exist; table ext_audit does not exist';
        Orm::connectSchema($dsn, $member, $config)->close();

        $db = Orm::connect($dsn, $config);
        try {
            $schema = $db->utils()->schema();
            $exists = static function (string $table) use ($db): bool {
                try {
                    $db->pdo()->query("SELECT COUNT(*) FROM $table")->fetchColumn();
                    return true;
                } catch (PDOException) {
                    return false;
                }
            };
            $expectConfig('install before core', static fn() => $schema->install($member), $missing);
            $expectConfig('addTablesAndColumns before core', static fn() => $schema->addTablesAndColumns($member), $missing);
            self::check(!$exists('ext_post'), 'ext_post exists after the refused install');

            $schema->install($core);
            $db->pdo()->exec("INSERT INTO ext_account (name) VALUES ('kim')");
            $schema->install($member);
            $schema->install($member);
            foreach (['ext_post', 'ext_post_history'] as $table) {
                self::check($exists($table), "$table does not exist after the member install");
            }
            Orm::connectSchema($dsn, $member, $config)->close();

            $db->transaction(fn() => (new \Polyspec\Orm\Tests\ExtMember\ExtPost)($db)->setAccountSeq(1)->setTitle('hello')->create(), audit: []);
            [$audit, $actor] = $db->pdo()->query('SELECT seq, actor FROM ext_audit')->fetch(PDO::FETCH_NUM);
            $recorded = $db->pdo()->query('SELECT audit_seq FROM ext_post_history')->fetchColumn();
            self::check($actor === 'writer' && (int) $recorded === (int) $audit, "audit record ($audit, $actor) and history audit $recorded, want the record of writer in the history");

            $added = $schema->addTablesAndColumns($member);
            self::check($added === [], 'addTablesAndColumns of the installed member: ' . json_encode($added) . ', want nothing');
            $added = $schema->addTablesAndColumns($memberV2);
            self::check($added === ['ext_post.summary', 'ext_post_history.summary'], 'addTablesAndColumns of member_v2: ' . json_encode($added));
            $accounts = (int) $db->pdo()->query('SELECT COUNT(*) FROM ext_account')->fetchColumn();
            self::check($accounts === 1, "ext_account has $accounts rows after the member changes, want 1");

            $differs = 'the tables that the set uses from external documents differ from the database: column ext_account.nick does not exist';
            Orm::connectSchema($dsn, $drifted, $config)->close();
            $expectConfig('install with a drifted external table', static fn() => $schema->install($drifted), $differs);
            $expectConfig('addTablesAndColumns with a drifted external table', static fn() => $schema->addTablesAndColumns($drifted), $differs);
        } finally {
            $db->close();
        }
    }

    /**
     * Registration sends no statement to the database (docs/schema.md "Schema registration").
     * On a connection opened with StatementCountingPdo, register does not read the database, even for a set that uses external documents,
     * and text that does not hash to the declared hash is CONFIG with no statement. A request for a registered bench set runs on that
     * connection. connectSchema sends only the statements that connect sends.
     */
    private static function registerSendsNoStatement(string $dsn): void
    {
        ['member' => $member] = self::externalSets();
        $installer = Orm::connect($dsn, new Config());
        try {
            $installer->utils()->schema()->install(\Polyspec\Orm\Tests\Model\schema());
        } finally {
            $installer->close();
        }
        [$driver, $pdoDsn, $user, $password] = Orm::parseDsn($dsn);
        $pdo = new StatementCountingPdo($pdoDsn, $user, $password);
        $db = new \Polyspec\Orm\Db($pdo, $driver, new Config(), new DateTimeZone('UTC'));
        try {
            self::check(self::code(fn() => (new User)($db)->getCount()) === Code::SCHEMA_HASH_MISMATCH, 'bench read before the register');
            $before = $pdo->sent;
            $db->utils()->schema()->register(\Polyspec\Orm\Tests\Model\schema());
            $db->utils()->schema()->register(\Polyspec\Orm\Tests\Model\schema());
            $db->utils()->schema()->register($member);
            $bench = \Polyspec\Orm\Tests\Model\schema();
            $edited = new Schema($bench->manifestText . "\n", $bench->manifestHash);
            self::check(self::code(fn() => $db->utils()->schema()->register($edited)) === Code::CONFIG, 'register of a text that does not hash to its declared hash');
            $sent = $pdo->sent - $before;
            self::check($sent === 0, "register sent $sent statements, want 0");
            $users = (new User)($db)->getCount();
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

    /** @return list<array<string, mixed>> the cases of contracts/fixtures/install/changed_database.json */
    private static function changedDatabaseFixture(): array
    {
        $fixture = json_decode((string) file_get_contents(dirname(__DIR__, 3) . "/contracts/fixtures/install/changed_database.json"), true, flags: JSON_THROW_ON_ERROR);
        self::check($fixture['cases'] !== [], 'contracts/fixtures/install/changed_database.json has no cases');
        return $fixture['cases'];
    }

    /**
     * install compares the whole database with the set, not only the table names (docs/schema.md "Schema
     * installation"). For each case of contracts/fixtures/install/changed_database.json, a database changed by a statement outside the ORM
     * is installed again with the same set: it is CONFIG, the dialect's message, and the database stays as it is.
     */
    private static function installVerifiesTheDatabase(string $dsn, array $case): void
    {
        [$driver] = Orm::parseDsn($dsn);
        self::check($case['operation'] === 'install', "{$case['id']}: the operation {$case['operation']}, want install");
        $document = (string) file_get_contents(self::$root . "/contracts/fixtures/{$case['document']}");
        $documents = RuntimeModel::parse([basename($case['document']) => $document]);
        $model = RuntimeModel::build($documents);
        $schema = new Schema($model->manifestText, $model->manifestHash);
        $db = Orm::connect($dsn, new Config());
        try {
            $db->utils()->schema()->install($schema);
            $db->pdo()->exec($case['statement']);
            $want = "{$case['expected']['code']}: {$case['expected']['message'][$driver]}";
            try {
                $db->utils()->schema()->install($schema);
                self::check(false, "{$case['id']}: install over the changed database: no error, want $want");
            } catch (OrmException $e) {
                self::check($e->code_ === $case['expected']['code'] && $e->getMessage() === $want, "{$case['id']}: install over the changed database: {$e->code_} {$e->getMessage()}, want $want");
            }
            $db->pdo()->query($case['remaining'])->fetchAll();
            // The next case uses the same case database, so this case's table is removed.
            foreach ($documents as $parsed) {
                foreach ($parsed->tables as $table) {
                    $db->pdo()->exec("DROP TABLE {$table->name}");
                }
            }
        } finally {
            $db->close();
        }
    }

    public static function setUpBeforeClass(): void
    {
        self::fixture();
    }

    /** @return iterable<string, array{string}> the drivers of the case, each a data set */
    public static function drivers(): iterable
    {
        foreach (['sqlite', 'mysql', 'postgres'] as $driver) {
            yield $driver => [$driver];
        }
    }

    #[DataProvider('drivers')]
    public function test_several_schemas(string $driver): void
    {
        // The case installs its documents in a case database of its own, removed when it ends, also when it fails.
        with_case_database($driver, static function (string $step): void {}, static fn(string $dsn) => self::severalSchemas($dsn));
    }

    #[DataProvider('drivers')]
    public function test_unregistered_schema(string $driver): void
    {
        // The case installs its documents in a case database of its own, removed when it ends, also when it fails.
        with_case_database($driver, static function (string $step): void {}, static fn(string $dsn) => self::unregisteredSchema($dsn));
    }

    #[DataProvider('drivers')]
    public function test_edited_manifest(string $driver): void
    {
        // The case installs its documents in a case database of its own, removed when it ends, also when it fails.
        with_case_database($driver, static function (string $step): void {}, static fn(string $dsn) => self::editedManifest($dsn));
    }

    #[DataProvider('drivers')]
    public function test_external_documents(string $driver): void
    {
        // The case installs its documents in a case database of its own, removed when it ends, also when it fails.
        with_case_database($driver, static function (string $step): void {}, static fn(string $dsn) => self::externalDocuments($dsn));
    }

    #[DataProvider('drivers')]
    public function test_register_sends_no_statement(string $driver): void
    {
        // The case installs its documents in a case database of its own, removed when it ends, also when it fails.
        with_case_database($driver, static function (string $step): void {}, static fn(string $dsn) => self::registerSendsNoStatement($dsn));
    }

    /** @return iterable<string, array{array<string, mixed>}> the cases of changed_database.json by their ids */
    public static function changedDatabaseCases(): iterable
    {
        foreach (self::changedDatabaseFixture() as $case) {
            yield $case['id'] => [$case];
        }
    }

    // Each case of changed_database.json runs on every driver, in a case database of its own per driver, removed when it
    // ends, also when it fails.
    #[DataProvider('changedDatabaseCases')]
    public function test_install_verifies_the_database(array $case): void
    {
        foreach (['sqlite', 'mysql', 'postgres'] as $driver) {
            with_case_database($driver, static function (string $step): void {}, static fn(string $dsn) => self::installVerifiesTheDatabase($dsn, $case));
        }
    }
}
