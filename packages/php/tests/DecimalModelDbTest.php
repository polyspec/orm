<?php

// The generated decimal model of contracts/fixtures/decimal_schema.dbs on one database of each dialect: the generated
// getter and setter take exact strings and refuse other values, and a row written and read in a transaction keeps its
// exact values in the model, its row output and the database, and is gone after the rollback. Each dialect is a data
// set; each dialect takes its DSN from the isolated decimal database of the current run (DECIMAL_<DIALECT>_DSN).
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist --filter '@<dialect>$'
// packages/php/tests/DecimalModelDbTest.php
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDO;
use ReflectionMethod;
use ReflectionNamedType;
use RuntimeException;
use TypeError;
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
    use ThreeDrivers;

    /** The directory of the loaded generated model; removed when the class ends. */
    private static ?string $generated = null;

    /** Generates the model of the fixture into a new directory. */
    private static function generate(): string
    {
        $model = RuntimeModel::build(
            RuntimeModel::files([dirname(__DIR__, 3) . '/contracts/fixtures/decimal_schema.dbs'])
        );
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
        requireGeneratedClasses($generated);
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
        $variable = 'DECIMAL_' . strtoupper($dialect) . '_DSN';
        return requiredDsn($variable);
    }

    /** The generator writes the model of the fixture; the generated files are removed again. */
    #[DataProvider('drivers')]
    public function testGenerate(string $dialect): void
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

    #[DataProvider('drivers')]
    public function testSetters(string $dialect): void
    {
        // The test of COD-2 (docs/spec).
        self::dsn($dialect);
        self::load();
        $class = \DecimalFixture\DecimalCase::class;
        $getAmount = (new ReflectionMethod($class, 'getAmount'))->getReturnType();
        $setAmount = (new ReflectionMethod($class, 'setAmount'))->getParameters()[0]->getType();
        self::assertTrue(
            $getAmount instanceof ReflectionNamedType
                && $setAmount instanceof ReflectionNamedType
                && $getAmount->getName() === 'string'
                && $setAmount
                ->getName() === 'string',
            'generated decimal getter and setter must use exact string values'
        );
        foreach (['1.00001', '1000000000.0000', 'NaN'] as $invalid) {
            try {
                (new $class())->setAmount($invalid);
                self::fail("invalid decimal $invalid was accepted");
            } catch (OrmException $error) {
                self::assertSame(
                    Code::CODEC_ENCODE,
                    $error->code_,
                    "invalid decimal $invalid returned {$error->code_}"
                );
            }
        }
        // The generated setters accept exact strings only.
        try {
            (new $class())->setAmount(48.045);
            self::fail('binary64 decimal input was accepted');
        } catch (TypeError) {
            self::addToAssertionCount(1);
        }
        try {
            (new $class())->setLargeValue(9007199254740992);
            self::fail('binary64 large decimal input was accepted');
        } catch (TypeError) {
            self::addToAssertionCount(1);
        }
    }

    /** A row written and read back in a transaction that rolls back. */
    // Requirements: DIA-25, COD-2.
    #[DataProvider('drivers')]
    public function testRoundTrip(string $dialect): void
    {
        self::roundTrip($this, $dialect);
    }

    /** Executes the shared physical decimal case with the caller's assertion recorder. */
    public static function roundTrip(TestCase $test, string $dialect): void
    {
        // The test of COD-2 (docs/spec).
        self::roundTripAt($test, $dialect, self::dsn($dialect));
    }

    /** Executes the same decimal round-trip against a private SQLite file, without a server DSN. */
    public static function roundTripSqlite(TestCase $test): void
    {
        $path = tempnam(sys_get_temp_dir(), 'orm-decimal-native-');
        if ($path === false) {
            throw new RuntimeException('cannot create the private decimal SQLite database file');
        }
        try {
            self::roundTripAt($test, 'sqlite', 'sqlite://' . $path);
        } finally {
            foreach ([$path, $path . '-wal', $path . '-shm'] as $file) {
                if (file_exists($file) && !unlink($file)) {
                    throw new RuntimeException("cannot remove the private decimal SQLite file $file");
                }
            }
        }
    }

    private static function roundTripAt(TestCase $test, string $dialect, string $dsn): void
    {
        self::load();
        $class = \DecimalFixture\DecimalCase::class;
        $db = \DecimalFixture\connect($dsn, new Config());
        try {
            $db->utils()->schema()->install(\DecimalFixture\schema());
            $test->assertSame(
                0,
                (new $class())->connect($db)->seq(1)->getCount(),
                'decimal fixture row 1 exists before the test'
            );
            $rollback = new RuntimeException('decimal fixture rollback');
            try {
                $db->transaction(static function () use ($test, $class, $db, $dialect, $rollback): void {
                    (new $class())->setSeq(1)->setAmount('48.0450')->setLargeValue('9007199254740993')->create();
                    $loaded = (new $class())->seq(1)->get();
                    $test->assertTrue(
                        $loaded->getAmount() === '48.0450' && $loaded->getLargeValue() === '9007199254740993',
                        'generated decimal fields lost exact values'
                    );
                    $array = $loaded->toArray();
                    $test->assertTrue(
                        $array['amount'] === '48.0450' && $array['large_value'] === '9007199254740993',
                        'decimal row output lost exact values'
                    );
                    $query = $db->pdo()->prepare('SELECT amount, large_value FROM decimal_case WHERE seq = ?');
                    $query->execute([1]);
                    $stored = $query->fetch(PDO::FETCH_NUM);
                    $test->assertTrue(
                        $stored !== false && (string) $stored[0] === (
                            $dialect === 'sqlite' ? '480450' : '48.0450'
                        ) && (string) $stored[1] === '9007199254740993',
                        'database decimal storage lost exact values'
                    );
                    throw $rollback;
                }, retry: 0);
                $test->fail('decimal transaction unexpectedly committed');
            } catch (RuntimeException $error) {
                if ($error !== $rollback) {
                    throw $error;
                }
            }
            $test->assertSame(
                0,
                (new $class())->connect($db)->seq(1)->getCount(),
                'decimal fixture row remains after rollback'
            );
        } finally {
            $db->close();
        }
    }
}
