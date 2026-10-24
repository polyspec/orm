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
    // Requirements: DBS-108, SCH-7.
    public function testSchemaInstallExisting(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [, $dsn] = coverageItem();
            Assert::assertIsString($dsn);
            coverageAssertEntryClassesAreInternal();
            self::assertNativeSchemaUtils();
            $db = coverageConnect($dsn);
            try {
                Assert::assertTrue(coverageTableExists($db, 'author'), 'the bench database has no author table');
                $db->utils()->schema()->install(\Polyspec\Orm\Tests\Model\schema());
            } finally {
                $db->close();
            }
        }
    }

    // Requirements: DBS-108, SCH-10.
    public function testSchemaInstallPartial(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [, $dsn] = coverageItem();
            Assert::assertIsString($dsn);
            coverageAssertEntryClassesAreInternal();
            self::assertNativeSchemaUtils();
            $db = coverageConnect($dsn);
            try {
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
            } finally {
                $db->close();
            }
        }
    }

    // Requirements: DBS-107, SCH-7.
    public function testSchemaInstallExternalDocuments(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [, $dsn] = coverageItem();
            Assert::assertIsString($dsn);
            coverageAssertEntryClassesAreInternal();
            self::assertNativeSchemaUtils();
            $manifest = self::externalSchema(NATIVE_EXTERNAL_USER);
            $drifted = self::externalSchema(str_replace(
                "  name varchar(191)\n",
                "  name varchar(191)\n  coverage_missing varchar(8) null\n",
                NATIVE_EXTERNAL_USER
            ));
            $db = coverageConnect($dsn);
            $events = [];
            $unsubscribe = $db->subscribe(static function ($event) use (&$events): void {
                $events[] = $event->kind;
            });
            try {
                $db->utils()->schema()->register($manifest);
                Assert::assertSame([], $events, 'register must not read or write the database');
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
