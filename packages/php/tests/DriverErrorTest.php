<?php

declare(strict_types=1);

// Driver errors that the error catalog does not list, and CHECK violations,
// on SQLite, MySQL and PostgreSQL. refused_row is immutable, so its triggers
// refuse every update with a database error that the catalog does not list;
// the client reports it as an OrmException with the code DRIVER, the driver
// message, and the driver error as its previous exception. Its CHECK
// constraint refuses a nonpositive amount with CONSTRAINT. Each case runs in a case
// database of its own (case_database.php) created through ORM_TEST_MYSQL_DSN or
// ORM_TEST_POSTGRES_DSN; the test fails when either is unset.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DriverErrorTest.php
// [--filter <case>]
require_once __DIR__ . '/case_database.php';

use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Generator;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Tests\RefusalCase\RefusedRow;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\DataProvider;

#[Medium]
final class DriverErrorTest extends TestCase
{
    private static mixed $documents = null;

    /** The fixture of the file: what the script did before its cases, once per class. */
    private static function fixture(): void
    {
        $work = sys_get_temp_dir() . '/orm-php-driver-error-' . getmypid();
        @mkdir($work, 0o700, true);
        register_shutdown_function(static function () use ($work): void {
            exec('rm -rf ' . escapeshellarg($work));
        });

        self::$documents = [(string) file_get_contents(dirname(__DIR__, 3) . '/contracts/fixtures/refusal.dbs')];
        Generator::generate(
            RuntimeModel::build(RuntimeModel::parse(['refusal.dbs' => self::$documents[0]])),
            "$work/models",
            'Polyspec\\Orm\\Tests\\RefusalCase'
        );
        spl_autoload_register(static function (string $class) use ($work): void {
            if (str_starts_with($class, 'Polyspec\\Orm\\Tests\\RefusalCase\\')) {
                require "$work/models/" . substr($class, strlen('Polyspec\\Orm\\Tests\\RefusalCase\\')) . '.php';
            }
        });
        require "$work/models/bootstrap.php";
    }

    private static function check(bool $ok, string $message): void
    {
        \PHPUnit\Framework\Assert::assertTrue($ok, $message);
    }

    /** The error a call raises, or null when it returns. */
    private static function raised(callable $f): ?Throwable
    {
        try {
            $f();
        } catch (Throwable $e) {
            return $e;
        }
        return null;
    }

    private static function connect(string $dsn): Db
    {
        $db = Orm::connect($dsn, new Config());
        $db->utils()->schema()->install(\Polyspec\Orm\Tests\RefusalCase\schema());
        return $db;
    }

    /** An update that the immutable trigger refuses fails with DRIVER and keeps the driver error. */
    private static function triggerRefused(string $dsn): void
    {
        $db = self::connect($dsn);
        try {
            $row = (new RefusedRow())($db)->setAmount(1)->create();
            $e = self::raised(fn() => $row->setAmount(2)->update());
            self::check(
                $e instanceof OrmException,
                'refused update raises ' . ($e === null ? 'nothing' : $e::class . ': ' . $e->getMessage())
            );
            if ($e instanceof OrmException) {
                self::check($e->code_ === Code::DRIVER, "refused update code {$e->code_}");
                self::check(
                    str_contains($e->getMessage(), 'table refused_row is immutable'),
                    "refused update message {$e->getMessage()}"
                );
                self::check($e->getPrevious() instanceof PDOException, 'refused update keeps the driver error');
            }
            self::check(
                (new RefusedRow())($db)->addAllColumns()->getBySeq($row->getSeq())->getAmount() === 1,
                'refused update keeps the row'
            );
        } finally {
            $db->close();
        }
    }

    /** An insert that the CHECK constraint refuses fails with CONSTRAINT. */
    private static function checkRefused(string $dsn): void
    {
        $db = self::connect($dsn);
        try {
            $e = self::raised(fn() => (new RefusedRow())($db)->setAmount(0)->create());
            self::check(
                $e instanceof OrmException,
                'refused insert raises ' . ($e === null ? 'nothing' : $e::class . ': ' . $e->getMessage())
            );
            if ($e instanceof OrmException) {
                self::check($e->code_ === Code::CONSTRAINT, "refused insert code {$e->code_}");
                self::check(
                    str_contains($e->getMessage(), 'amount_positive'),
                    "refused insert message {$e->getMessage()}"
                );
                self::check($e->getPrevious() instanceof PDOException, 'refused insert keeps the driver error');
            }
            self::check((new RefusedRow())($db)->getCount() === 0, 'refused insert writes no row');
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
    public function testTriggerRefused(string $driver): void
    {
        // The case installs its documents in a case database of its own, removed when it ends, also when it fails.
        with_case_database($driver, static function (string $step): void {
        }, static fn(string $dsn) => self::triggerRefused($dsn));
    }

    #[DataProvider('drivers')]
    public function testCheckRefused(string $driver): void
    {
        // The case installs its documents in a case database of its own, removed when it ends, also when it fails.
        with_case_database($driver, static function (string $step): void {
        }, static fn(string $dsn) => self::checkRefused($dsn));
    }
}
