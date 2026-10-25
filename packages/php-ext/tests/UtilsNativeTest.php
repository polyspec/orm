<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\PrivilegeUtils;
use Polyspec\Orm\SchemaUtils;
use Polyspec\Orm\Stats;
use Polyspec\Orm\Utils;
use Polyspec\Orm\Tests\WasInsertedCases;

#[Medium]
final class UtilsNativeTest extends TestCase
{
    public function testNativeUtilityConstructorsKeepTheirTypeErrors(): void
    {
        foreach (
            [
                \Polyspec\Orm\AesUtils::class => 'AesUtils',
                PrivilegeUtils::class => 'PrivilegeUtils',
                SchemaUtils::class => 'SchemaUtils',
            ] as $class => $name
        ) {
            try {
                new $class(new \stdClass(), new \stdClass());
                self::fail("$name accepted objects that are not a Db and Utils");
            } catch (\TypeError $error) {
                self::assertSame("$name expects a Db and Utils", $error->getMessage());
            }
        }
    }

    public function testWasInsertedTracksGeneratedRowsThroughNativeUtils(): void
    {
        self::assertTrue((new \ReflectionClass(Utils::class))->isInternal());
        self::assertTrue((new \ReflectionClass(Utils::class))->getMethod('wasInserted')->isInternal());

        WasInsertedCases::onSqlite(function (\Polyspec\Orm\Db $db): void {
            WasInsertedCases::assertTracksGeneratedRows($this, $db);
        });
    }

    public function testWasInsertedChecksTransactionBeforeArguments(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'orm-utils-was-inserted-');
        self::assertIsString($path);
        try {
            $db = Orm::connect('sqlite:///' . $path, new Config());
            $events = [];
            $unsubscribe = subscribeToNativeTestEvents($db, $events);
            for ($attempt = 0; $attempt < 2; $attempt++) {
                try {
                    $db->utils()->wasInserted('', 0);
                    self::fail('wasInserted accepted invalid arguments outside a transaction');
                } catch (OrmException $error) {
                    self::assertSame(Code::CONFIG, $error->code_);
                    self::assertSame(
                        'CONFIG: wasInserted requires an active transaction of the connection',
                        $error->getMessage()
                    );
                }
                self::assertSame([], $events);
            }
            $unsubscribe();
            $db->close();
        } finally {
            if (is_file($path)) {
                unlink($path);
            }
        }
    }

    public function testNativeUtilitiesUseTheActiveTransactionAndKeepItsLocalState(): void
    {
        $class = new \ReflectionClass(Utils::class);
        self::assertTrue($class->isInternal());
        foreach (['local', 'lock', 'setLocal', 'wasInserted', 'backendWaitingForLock'] as $method) {
            self::assertTrue($class->getMethod($method)->isInternal());
        }

        $path = tempnam(sys_get_temp_dir(), 'orm-utils-native-');
        self::assertIsString($path);
        try {
            $db = Orm::connect('sqlite:///' . $path, new Config());
            $utils = $db->utils();
            self::assertInstanceOf(SchemaUtils::class, $utils->schema());
            self::assertInstanceOf(PrivilegeUtils::class, $utils->privileges());
            self::assertInstanceOf(Stats::class, $utils->stats());
            self::assertFalse($utils->backendWaitingForLock());

            try {
                $utils->local('trace.id');
                self::fail('local read outside a transaction did not fail');
            } catch (OrmException $error) {
                self::assertSame(Code::CONFIG, $error->code_);
            }

            $value = $utils->run(function () use ($utils): string {
                self::assertSame('nested', $utils->run(static fn(): string => 'nested'));
                $utils->setLocal('trace.id', 'first');
                self::assertSame('first', $utils->local('trace.id'));
                $utils->setLocal('trace.id', 'second');
                self::assertSame('second', $utils->local('trace.id'));
                $utils->lock('native_utils.lock');
                self::assertFalse($utils->wasInserted('Author', 1));
                $utils->exec('utility', [], 'SELECT 1', []);
                self::assertSame(1, $utils->read('utility', [], 'SELECT 1', []));
                return 'complete';
            });
            self::assertSame('complete', $value);

            try {
                $utils->run(static function () use ($utils): void {
                    $utils->local('missing');
                });
                self::fail('a missing local value did not fail');
            } catch (OrmException $error) {
                self::assertSame(Code::NO_ROWS, $error->code_);
            }

            $db->close();
        } finally {
            if (is_file($path)) {
                unlink($path);
            }
        }
    }
}
