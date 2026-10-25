<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;

/** Shared assertions for the PHP and native extension MySQL TLS cases. */
final class MysqlTlsCases
{
    public static function assertRefused(string $dsn, string $wanted): void
    {
        try {
            Orm::parseDsn($dsn);
            Assert::fail("accepted $dsn");
        } catch (OrmException $error) {
            Assert::assertSame(Code::CONFIG, $error->code_, "$dsn: {$error->getMessage()}");
            Assert::assertStringContainsString($wanted, $error->getMessage(), $dsn);
        }
    }

    public static function assertUnsupportedOptions(string $dsnRoot, string $caParameter): void
    {
        foreach (['VERIFY_CA', 'REQUIRED', 'PREFERRED', 'DISABLED', 'verify_identity', ''] as $mode) {
            self::assertRefused(
                "$dsnRoot?ssl-mode=$mode&ssl-ca=$caParameter",
                'ssl-mode'
            );
        }
        self::assertRefused("$dsnRoot?ssl-mode=VERIFY_IDENTITY", 'ssl-ca');
        self::assertRefused("$dsnRoot?ssl-mode=VERIFY_IDENTITY&ssl-ca=ca.pem", 'absolute');
        self::assertRefused("$dsnRoot?ssl-ca=$caParameter", 'ssl-mode');
    }

    public static function assertMissingCaRejected(string $dsnPrefix, string $failureMessage): void
    {
        $ca = sys_get_temp_dir() . '/orm-missing-ca-' . bin2hex(random_bytes(8)) . '.pem';
        $db = null;
        try {
            $db = Orm::connect($dsnPrefix . rawurlencode($ca), new Config());
            Assert::fail($failureMessage);
        } catch (OrmException $error) {
            Assert::assertSame(Code::CONFIG, $error->code_);
            Assert::assertStringContainsString('not a readable file', $error->getMessage());
        } finally {
            $db?->close();
        }
    }

    public static function assertSessionSqlMode(string $dsn): void
    {
        $vector = json_decode(
            (string) file_get_contents(dirname(__DIR__, 3) . '/tests/dsn/mysql-session.json'),
            true,
            512,
            JSON_THROW_ON_ERROR
        );
        $db = Orm::connect($dsn, new Config(statementTimeoutMs: 237));
        try {
            $session = $db->pdo()->query(
                'SELECT @@SESSION.sql_mode, @@SESSION.time_zone, @@SESSION.max_execution_time'
            )->fetch(\PDO::FETCH_NUM);
        } finally {
            $db->close();
        }
        Assert::assertSame($vector['sql_mode']['session'], $session[0] ?? null, '@@SESSION.sql_mode');
        Assert::assertSame('+00:00', $session[1] ?? null, '@@SESSION.time_zone');
        Assert::assertSame(237, (int) ($session[2] ?? -1), '@@SESSION.max_execution_time');
    }

    public static function sslVersion(string $dsn): string
    {
        $db = Orm::connect($dsn, new Config());
        try {
            return (string) (
                $db->pdo()->query("SHOW SESSION STATUS LIKE 'Ssl_version'")->fetch(\PDO::FETCH_NUM)[1] ?? ''
            );
        } finally {
            $db->close();
        }
    }
}
