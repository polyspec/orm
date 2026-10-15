<?php
// The generated decimal model of contracts/fixtures/decimal_schema.dbs on one database of each dialect: the generated
// getter and setter take exact strings and refuse other values, and a row written and read in a transaction keeps its
// exact values in the model, its row output and the database, and is gone after the rollback. Each dialect is a data
// set; each dialect takes its DSN from the test servers' environment or databases-create (BENCH_SQLITE_DSN).
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist --filter '@<dialect>$' packages/php/tests/DecimalModelDbTest.php
declare(strict_types=1);

require_once __DIR__ . '/coverage_cases.php';

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Generator;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;

#[Medium]
final class DecimalModelDbTest extends TestCase
{
    /** The directory of the loaded generated model; removed when the class ends. */
    private static ?string $generated = null;

    /** @return iterable<string, array{string}> */
    public static function dialects(): iterable
    {
        foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
            yield $dialect => [$dialect];
        }
    }

    /** Generates the model of the fixture into a new directory. */
    private static function generate(): string
    {
        $model = RuntimeModel::build(RuntimeModel::files([dirname(__DIR__, 3) . '/contracts/fixtures/decimal_schema.dbs']));
        $generated = sys_get_temp_dir() . '/orm-decimal-php-' . bin2hex(random_bytes(8));
        Generator::generate($model, $generated, 'DecimalFixture');
        return $generated;
    }

    /** Removes a generated model directory; a file that cannot be removed fails. */
    private static function remove(string $generated): void
    {
        $files = glob($generated . '/*.php');
        if ($files === false) {
            throw new RuntimeException("cannot list generated model directory $generated");
        }
        foreach ($files as $file) {
            if (!unlink($file)) {
                throw new RuntimeException("cannot remove generated model $file");
            }
        }
        if (!rmdir($generated)) {
            throw new RuntimeException("cannot remove generated model directory $generated");
        }
    }

    /** The generated model, generated and loaded once per process. */
    private static function load(): void
    {
        if (self::$generated !== null) {
            return;
        }
        $generated = self::$generated = self::generate();
        spl_autoload_register(static function (string $class) use ($generated): void {
            if (str_starts_with($class, 'DecimalFixture\\')) {
                require $generated . '/' . substr($class, strlen('DecimalFixture\\')) . '.php';
            }
        });
        require $generated . '/bootstrap.php';
    }

    public static function tearDownAfterClass(): void
    {
        if (self::$generated !== null) {
            self::remove(self::$generated);
        }
    }

    private static function dsn(string $dialect): string
    {
        // Each dialect takes its database from the same helper as the other database tests: sqlite the bench file of
        // databases-create (BENCH_SQLITE_DSN), mysql and postgres their test server.
        $variable = $dialect === 'sqlite' ? 'BENCH_SQLITE_DSN' : 'ORM_TEST_' . strtoupper($dialect) . '_DSN';
        return requiredDsn($variable);
    }

    /** The generator writes the model of the fixture; the generated files are removed again. */
    #[DataProvider('dialects')]
    public function test_generate(string $dialect): void
    {
        self::dsn($dialect);
        $generated = self::generate();
        try {
            self::assertFileExists("$generated/bootstrap.php");
            self::assertFileExists("$generated/DecimalCase.php");
        } finally {
            self::remove($generated);
        }
    }

    #[DataProvider('dialects')]
    public function test_setters(string $dialect): void
    {
        self::dsn($dialect);
        self::load();
        $class = DecimalFixture\DecimalCase::class;
        $getAmount = (new ReflectionMethod($class, 'getAmount'))->getReturnType();
        $setAmount = (new ReflectionMethod($class, 'setAmount'))->getParameters()[0]->getType();
        self::assertTrue($getAmount instanceof ReflectionNamedType && $setAmount instanceof ReflectionNamedType && $getAmount->getName() === 'string' && $setAmount->getName() === 'string', 'generated decimal getter and setter must use exact string values');
        foreach (['1.00001', '1000000000.0000', 'NaN'] as $invalid) {
            try {
                (new $class)->setAmount($invalid);
                self::fail("invalid decimal $invalid was accepted");
            } catch (OrmException $error) {
                self::assertSame(Code::CODEC_ENCODE, $error->code_, "invalid decimal $invalid returned {$error->code_}");
            }
        }
        // The generated setters accept exact strings only.
        try {
            (new $class)->setAmount(48.045);
            self::fail('binary64 decimal input was accepted');
        } catch (TypeError) {
            self::addToAssertionCount(1);
        }
        try {
            (new $class)->setLargeValue(9007199254740992);
            self::fail('binary64 large decimal input was accepted');
        } catch (TypeError) {
            self::addToAssertionCount(1);
        }
    }

    /** A row written and read back in a transaction that rolls back. */
    #[DataProvider('dialects')]
    public function test_round_trip(string $dialect): void
    {
        $dsn = self::dsn($dialect);
        self::load();
        $class = DecimalFixture\DecimalCase::class;
        $db = DecimalFixture\connect($dsn, new Config());
        $db->utils()->schema()->install(DecimalFixture\schema());
        try {
            self::assertSame(0, (new $class)->connect($db)->seq(1)->getCount(), 'decimal fixture row 1 exists before the test');
            $rollback = new RuntimeException('decimal fixture rollback');
            try {
                $db->transaction(static function () use ($class, $db, $dialect, $rollback): void {
                    (new $class)->setSeq(1)->setAmount('48.0450')->setLargeValue('9007199254740993')->create();
                    $loaded = (new $class)->seq(1)->get();
                    self::assertTrue($loaded->getAmount() === '48.0450' && $loaded->getLargeValue() === '9007199254740993', 'generated decimal fields lost exact values');
                    $array = $loaded->toArray();
                    self::assertTrue($array['amount'] === '48.0450' && $array['large_value'] === '9007199254740993', 'decimal row output lost exact values');
                    $query = $db->pdo()->prepare('SELECT amount, large_value FROM decimal_case WHERE seq = ?');
                    $query->execute([1]);
                    $stored = $query->fetch(PDO::FETCH_NUM);
                    self::assertTrue($stored !== false && (string) $stored[0] === ($dialect === 'sqlite' ? '480450' : '48.0450') && (string) $stored[1] === '9007199254740993', 'database decimal storage lost exact values');
                    throw $rollback;
                }, retry: 0);
                self::fail('decimal transaction unexpectedly committed');
            } catch (RuntimeException $error) {
                if ($error !== $rollback) {
                    throw $error;
                }
            }
            self::assertSame(0, (new $class)->connect($db)->seq(1)->getCount(), 'decimal fixture row remains after rollback');
        } finally {
            $db->close();
        }
    }
}
