<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// The session state of a transaction ends with the transaction (docs/spec/config.md CFG-30), on SQLite, MySQL and
// PostgreSQL, as packages/ts/tests/session_state.mjs runs it. A transaction of a Db, whose one PDO connection is its
// session, takes the named lock of utils()->lock, sets a local value with utils()->setLocal and commits. After it the
// session holds no value: PostgreSQL has no setting ormtest.session and MySQL no user variable orm.ormtest.session,
// which a statement on that PDO connection reads, and another connection takes the same lock. SQLite has no session
// setting, so it checks the lock alone. Each case runs in a case database of its own (case_database.php).
// Requirements: CFG-30, INT-50, INT-51.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/SessionStateTest.php

use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
final class SessionStateTest extends TestCase
{
    use ThreeDrivers;

    private const LEFTOVER = [
        'postgres' => "SELECT current_setting('ormtest.session', true)",
        'mysql' => 'SELECT @`orm.ormtest.session`',
    ];

    #[DataProvider('drivers')]
    public function testSessionStateEndsWithTransaction(string $driver): void
    {
        with_case_database($driver, static function (string $step): void {
        }, function (string $dsn) use ($driver): void {
            $key = 'orm_test.session.' . getmypid();
            $db = Orm::connect($dsn, new Config());
            $other = Orm::connect($dsn, new Config());
            try {
                $db->transaction(function () use ($db, $key): void {
                    $db->utils()->lock($key);
                    $db->utils()->setLocal('ormtest.session', 'kept');
                    self::assertSame('kept', $db->utils()->local('ormtest.session'));
                }, retry: 0);
                if (isset(self::LEFTOVER[$driver])) {
                    $value = $db->pdo()->query(self::LEFTOVER[$driver])->fetchColumn();
                    self::assertContains(
                        $value,
                        [null, ''],
                        "$driver: the session keeps the local value of the committed transaction"
                    );
                }
                $other->transaction(function () use ($other, $key): void {
                    $other->utils()->lock($key);
                }, retry: 0);
            } finally {
                $other->close();
                $db->close();
            }
        });
    }
}
