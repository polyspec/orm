<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use ReflectionMethod;
use RuntimeException;

final class MysqlTlsNativeTest extends TestCase
{
    // Requirements: CFG-18.
    public function testNativeOrmRejectsUnsupportedTlsOptions(): void
    {
        self::assertTrue((new ReflectionMethod(Orm::class, 'parseDsn'))->isInternal());
        $cases = [
            'mysql://orm@db.local/app?ssl-mode=VERIFY_CA&ssl-ca=%2Ftmp%2Fca.pem' => 'ssl-mode',
            'mysql://orm@db.local/app?ssl-mode=REQUIRED&ssl-ca=%2Ftmp%2Fca.pem' => 'ssl-mode',
            'mysql://orm@db.local/app?ssl-mode=PREFERRED&ssl-ca=%2Ftmp%2Fca.pem' => 'ssl-mode',
            'mysql://orm@db.local/app?ssl-mode=DISABLED&ssl-ca=%2Ftmp%2Fca.pem' => 'ssl-mode',
            'mysql://orm@db.local/app?ssl-mode=verify_identity&ssl-ca=%2Ftmp%2Fca.pem' => 'ssl-mode',
            'mysql://orm@db.local/app?ssl-mode=&ssl-ca=%2Ftmp%2Fca.pem' => 'ssl-mode',
            'mysql://orm@db.local/app?ssl-mode=VERIFY_IDENTITY' => 'ssl-ca',
            'mysql://orm@db.local/app?ssl-mode=VERIFY_IDENTITY&ssl-ca=ca.pem' => 'absolute',
            'mysql://orm@db.local/app?ssl-ca=%2Ftmp%2Fca.pem' => 'ssl-mode',
        ];
        foreach ($cases as $dsn => $expected) {
            try {
                Orm::parseDsn($dsn);
                self::fail("accepted unsupported TLS options in $dsn");
            } catch (OrmException $error) {
                self::assertSame(Code::CONFIG, $error->code_, "$dsn: {$error->getMessage()}");
                self::assertStringContainsString($expected, $error->getMessage(), $dsn);
            }
        }

        self::assertTrue((new ReflectionMethod(Orm::class, 'connect'))->isInternal());
        $ca = sys_get_temp_dir() . '/orm-missing-ca-' . bin2hex(random_bytes(8)) . '.pem';
        $db = null;
        try {
            $db = Orm::connect(
                'mysql://orm@localhost/app?ssl-mode=VERIFY_IDENTITY&ssl-ca=' . rawurlencode($ca),
                new Config()
            );
            self::fail('a missing native TLS CA file must be CONFIG');
        } catch (OrmException $error) {
            self::assertSame(Code::CONFIG, $error->code_);
            self::assertStringContainsString('not a readable file', $error->getMessage());
        } finally {
            $db?->close();
        }
    }

    // Requirements: CFG-16.
    public function testNativeOrmConnectsWithTlsIdentity(): void
    {
        self::assertTrue((new ReflectionMethod(Orm::class, 'connect'))->isInternal());
        $dsn = requiredDsn('ORM_TEST_MYSQL_TLS_DSN');
        if (!is_string($dsn) || $dsn === '') {
            throw new RuntimeException('ORM_TEST_MYSQL_TLS_DSN is not set; run make orm-test-servers');
        }
        $db = Orm::connect($dsn, new Config());
        try {
            $version = (string) (
                $db->pdo()->query("SHOW SESSION STATUS LIKE 'Ssl_version'")->fetch(\PDO::FETCH_NUM)[1] ?? ''
            );
            self::assertMatchesRegularExpression('/^TLSv1\.[23]$/', $version, 'the native connection uses TLS');
        } finally {
            $db->close();
        }
    }

    // Requirements: CFG-16.
    public function testNativeOrmRejectsUntrustedTlsIdentity(): void
    {
        self::assertTrue((new ReflectionMethod(Orm::class, 'connect'))->isInternal());
        foreach (['ORM_TEST_MYSQL_TLS_OTHER_CA_DSN', 'ORM_TEST_MYSQL_TLS_MISMATCH_DSN'] as $name) {
            $dsn = requiredDsn($name);
            if (!is_string($dsn) || $dsn === '') {
                throw new RuntimeException("$name is not set; run make orm-test-servers");
            }
            try {
                $db = Orm::connect($dsn, new Config());
            } catch (OrmException $error) {
                self::assertSame(Code::CONFIG, $error->code_, "$name: {$error->getMessage()}");
                self::assertStringContainsString('SSL', $error->getMessage(), "$name: {$error->getMessage()}");
                continue;
            }
            $db->close();
            self::fail("the native connection accepted untrusted TLS identity from $name");
        }
    }
}
