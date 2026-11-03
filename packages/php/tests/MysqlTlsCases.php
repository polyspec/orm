<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;

/** Shared assertions for the PHP and native extension MySQL TLS cases. */
final class MysqlTlsCases
{
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
