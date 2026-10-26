<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Code;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Schema;
use Polyspec\Orm\SchemaUtils;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

const NATIVE_EXTERNAL_USER = <<<'DBSPEC'
dbspec 1 bench_user

table user {
  seq i64 identity
  name varchar(191)
  primary key (seq)
}
DBSPEC;

const NATIVE_EXTERNAL_MEMBER = <<<'DBSPEC'
dbspec 1 coverage_external

use bench_user { user }

table coverage_external_post {
  seq i64 identity
  user_seq i64
  primary key (seq)
  index ix_coverage_external_post_user (user_seq)
  foreign key fk_coverage_external_post_user (user_seq) references user (seq)
}
DBSPEC;

#[Medium]
final class CoverageSchemaInstallNativeTest extends TestCase
{
    private static bool $nativeSchemaSetFixtureReady = false;

    // Requirements: DBS-108, SCH-7, PLN-44, INT-55.
    public function testSchemaInstallExisting(): void
    {
        self::forEachCoverageDatabase(static function ($db, string $driver): void {
            Assert::assertTrue(coverageTableExists($db, 'author'), 'the bench database has no author table');
            $db->utils()->schema()->install(\Polyspec\Orm\Tests\Model\schema());
            if ($driver === 'mysql') {
                $inside = coverageCode(fn() => $db->transaction(
                    fn() => $db->utils()->schema()->install(\Polyspec\Orm\Tests\Model\schema())
                ));
                Assert::assertSame(Code::CONFIG, $inside, 'MySQL install inside a transaction returns CONFIG');
            }
        });
    }

    // Requirements: DBS-108, SCH-10, PLN-44.
    public function testSchemaInstallPartial(): void
    {
        self::forEachCoverageDatabase(static function ($db): void {
            Assert::assertFalse(coverageTableExists($db, 'coverage_install_missing'));
            $manifest = RuntimeModel::build(RuntimeModel::parse([
                'partial.dbs' => <<<'DBSPEC'
dbspec 1 partial

table user {
  seq i64 identity
  name varchar(191)
  primary key (seq)
}

table coverage_install_missing {
  seq i64 identity
  primary key (seq)
}
DBSPEC,
            ]));
            try {
                $db->utils()->schema()->install(
                    new Schema($manifest->manifestText, $manifest->manifestHash)
                );
                Assert::fail('a partial document set install was accepted');
            } catch (OrmException $error) {
                Assert::assertSame(Code::CONFIG, $error->code_);
            }
            Assert::assertFalse(coverageTableExists($db, 'coverage_install_missing'));
        });
    }

    // Requirements: DBS-107, DBS-108, DBS-119, DBS-120, SCH-7, SCH-11, PLN-44, INT-54, INT-132, INT-133.
    public function testSchemaInstallExternalDocuments(): void
    {
        self::forEachCoverageDatabase(static function ($db): void {
            $manifest = self::externalSchema(NATIVE_EXTERNAL_USER);
            Assert::assertNotSame('', $manifest->externalText, 'the schema value has no external document text');
            [, $dsn] = coverageItem();
            coverageAssertRawConnectionRejectsUnregisteredBenchRequest($dsn);
            $badHash = new Schema(
                str_replace('coverage_external_post', 'coverage_external_post_changed', $manifest->manifestText),
                $manifest->manifestHash,
                $manifest->externalText,
            );
            try {
                \Polyspec\Orm\Orm::connectSchema((string) coverageItem()[1], $badHash, new \Polyspec\Orm\Config());
                Assert::fail('connect accepted manifest text that does not match its hash');
            } catch (OrmException $error) {
                Assert::assertSame(Code::CONFIG, $error->code_);
            }
            $drifted = self::externalSchema(str_replace(
                "  name varchar(191)\n",
                "  name varchar(191)\n  coverage_missing varchar(8) null\n",
                NATIVE_EXTERNAL_USER
            ));
            $events = [];
            $unsubscribe = $db->subscribe(static function ($event) use (&$events): void {
                $events[] = $event->kind;
            });
            try {
                $schema = $db->utils()->schema();
                $schema->register($manifest);
                $schema->register($manifest);
                $badHash = new Schema(
                    str_replace('coverage_external_post', 'coverage_external_post_changed', $manifest->manifestText),
                    $manifest->manifestHash,
                    $manifest->externalText,
                );
                try {
                    $schema->register($badHash);
                    Assert::fail('register accepted manifest text that does not hash to its declared hash');
                } catch (OrmException $error) {
                    Assert::assertSame(Code::CONFIG, $error->code_);
                }
                Assert::assertSame([], $events, 'register must not read or write the database');
                Assert::assertSame(
                    100000,
                    (new \Polyspec\Orm\Tests\Model\Author())($db)->getCount(),
                    'registering another manifest hash keeps the bench set selected'
                );
                try {
                    $db->utils()->schema()->install($drifted);
                    Assert::fail('an external schema difference was accepted');
                } catch (OrmException $error) {
                    Assert::assertSame(Code::CONFIG, $error->code_);
                    Assert::assertStringContainsString('user.coverage_missing does not exist', $error->getMessage());
                }
                Assert::assertFalse(coverageTableExists($db, 'coverage_external_post'));
            } finally {
                $unsubscribe();
            }
        });
    }

    // Requirements: DBS-108, SCH-7.
    public function testSchemaSetSeveralSchemas(): void
    {
        self::runNativeSchemaSet('testSeveralSchemas');
    }

    // Requirements: DBS-119.
    public function testSchemaSetUnregisteredSchema(): void
    {
        self::runNativeSchemaSet('testUnregisteredSchema');
    }

    // Requirements: DBS-120, SCH-7, SCH-11.
    public function testSchemaSetEditedManifest(): void
    {
        self::runNativeSchemaSet('testEditedManifest');
    }

    // Requirements: DBS-105, DBS-107, DBS-108, DBS-110, SCH-7, SCH-8.
    public function testSchemaSetExternalDocuments(): void
    {
        self::runNativeSchemaSet('testExternalDocuments');
    }

    /** Runs the library-owned scenario with the loaded native entry points and the same per-driver case databases. */
    private static function runNativeSchemaSet(string $method): void
    {
        \Polyspec\Orm\Extension\Tests\PhpExtensionBootstrapAssertions::requireLoaded();
        coverageAssertEntryClassesAreInternal();
        if (!self::$nativeSchemaSetFixtureReady) {
            \Polyspec\Orm\Tests\SchemaSetTest::setUpBeforeClass();
            self::$nativeSchemaSetFixtureReady = true;
        }
        $owner = new \Polyspec\Orm\Tests\SchemaSetTest($method);
        foreach (['sqlite', 'mysql', 'postgres'] as $driver) {
            $owner->{$method}($driver);
        }
    }

    /** @param callable(mixed, string): void $case */
    private static function forEachCoverageDatabase(callable $case): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [$driver, $dsn] = coverageItem();
            Assert::assertIsString($dsn);
            coverageAssertEntryClassesAreInternal();
            self::assertNativeSchemaUtils();
            $db = coverageConnect($dsn);
            try {
                $case($db, $driver);
            } finally {
                $db->close();
            }
        }
    }

    private static function assertNativeSchemaUtils(): void
    {
        $class = new \ReflectionClass(SchemaUtils::class);
        Assert::assertTrue($class->isInternal());
        foreach (['register', 'install', 'addTablesAndColumns', 'exists', 'installed', 'empty'] as $method) {
            Assert::assertTrue($class->getMethod($method)->isInternal(), "SchemaUtils::$method is not native");
        }
    }

    private static function externalSchema(string $external): Schema
    {
        $manifest = RuntimeModel::build(RuntimeModel::parseSet(
            ['coverage_external.dbs' => NATIVE_EXTERNAL_MEMBER],
            ['bench_user.dbs' => $external]
        ));
        return new Schema($manifest->manifestText, $manifest->manifestHash, $manifest->externalText);
    }
}
