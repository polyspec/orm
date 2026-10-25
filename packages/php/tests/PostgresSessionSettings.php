<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;

/** CFG-7 for the PHP library and the extension: PostgreSQL receives the session settings as startup parameters. */
final class PostgresSessionSettings
{
    /**
     * Connects to $dsn with a statement timeout of 237 ms and requires the UTC time zone and that timeout as settings
     * of the session, which a connection straight to the server (not through the pooler) gives as client parameters.
     */
    public static function assertStartupParameters(string $dsn): void
    {
        $db = Orm::connect($dsn, new Config(statementTimeoutMs: 237));
        try {
            $rows = $db->fetch(
                'utility',
                [],
                null,
                "SELECT name, setting, source FROM pg_settings WHERE name IN ('TimeZone', 'statement_timeout')"
            );
        } finally {
            $db->close();
        }
        $settings = [];
        foreach ($rows as [$name, $setting, $source]) {
            $settings[$name] = [$setting, $source];
        }
        Assert::assertSame('UTC', $settings['TimeZone'][0] ?? null, 'TimeZone');
        Assert::assertSame('237', $settings['statement_timeout'][0] ?? null, 'statement_timeout');
        if (getenv('ORM_TEST_POSTGRES_DSN') === getenv('ORM_TEST_POSTGRES_SERVER_DSN')) {
            Assert::assertSame('client', $settings['TimeZone'][1] ?? null, 'TimeZone startup source');
            Assert::assertSame('client', $settings['statement_timeout'][1] ?? null, 'timeout startup source');
        }
    }
}
