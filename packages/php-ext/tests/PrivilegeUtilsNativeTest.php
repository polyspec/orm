<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;

#[Medium]
final class PrivilegeUtilsNativeTest extends TestCase
{
    public function testGrantAndRevokeRejectInvalidTargetsBeforeQueries(): void
    {
        $db = new \Polyspec\Orm\Db(null, 'postgres', new Config(), new \DateTimeZone('UTC'));
        $privileges = $db->utils()->privileges();
        $cases = [
            [
                static fn() => $privileges->grantTable('sample', 'invalid-role'),
                'a qualified table name is required',
            ],
            [
                static fn() => $privileges->revokeTable('sample', 'SELECT', 'invalid-role'),
                'a qualified table name is required',
            ],
            [static fn() => $privileges->grantTable('public.sample', 'invalid-role'), 'role invalid-role is invalid'],
            [
                static fn() => $privileges->revokeTable('public.sample', 'SELECT', 'invalid-role'),
                'role invalid-role is invalid',
            ],
        ];
        foreach ($cases as [$operation, $message]) {
            try {
                $operation();
                self::fail('an invalid privilege target was accepted');
            } catch (OrmException $error) {
                self::assertSame(Code::CONFIG, $error->code_);
                self::assertSame("CONFIG: $message", $error->getMessage());
            }
        }
        $db->close();
    }

    public function testNativeTablePrivilegesArePostgresOnly(): void
    {
        $class = new \ReflectionClass(\Polyspec\Orm\PrivilegeUtils::class);
        self::assertTrue($class->isInternal());
        foreach (['grantTable', 'inspectTable', 'revokeTable'] as $method) {
            self::assertTrue($class->getMethod($method)->isInternal());
        }
        $path = tempnam(sys_get_temp_dir(), 'orm-privileges-native-');
        self::assertIsString($path);
        try {
            $db = Orm::connect('sqlite:///' . $path, new Config());
            $privileges = $db->utils()->privileges();
            $operations = [
                static fn() => $privileges->grantTable('main.sample', 'reader'),
                static fn() => $privileges->inspectTable('main.sample'),
                static fn() => $privileges->revokeTable('main.sample', 'SELECT', 'reader'),
            ];
            foreach ($operations as $operation) {
                try {
                    $operation();
                    self::fail('a PostgreSQL-only privilege operation ran on SQLite');
                } catch (OrmException $error) {
                    self::assertSame(
                        Code::CAPABILITY_UNSUPPORTED,
                        $error->code_,
                    );
                }
            }
            $db->close();
        } finally {
            if (is_file($path)) {
                unlink($path);
            }
        }
    }
}
