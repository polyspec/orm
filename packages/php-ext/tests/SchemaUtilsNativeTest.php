<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Config;
use Polyspec\Orm\Code;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Orm;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Schema;
use Polyspec\Orm\SchemaUtils;

#[Medium]
final class SchemaUtilsNativeTest extends TestCase
{
    public function testAddTablesAndColumnsRejectsExternalDriftWithoutChangingDatabase(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'orm-schema-external-');
        self::assertIsString($path);
        try {
            $db = Orm::connect('sqlite:///' . $path, new Config());
            $pdo = $db->pdo();
            $pdo->exec('CREATE TABLE shared (id BIGINT NOT NULL PRIMARY KEY)');
            $events = [];
            $unsubscribe = $db->subscribe(static function ($event) use (&$events): void {
                $events[] = $event;
            });
            $before = $pdo->query(
                "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' "
                . 'ORDER BY type, name'
            )->fetchAll(\PDO::FETCH_ASSOC);
            $foreignKeysBefore = $pdo->query('PRAGMA foreign_keys')->fetchColumn();
            $external = "dbspec 1 core\n\ntable shared {\n  id i32\n  primary key (id)\n}\n";
            $owned = "dbspec 1 app\n\nuse core { shared }\n\ntable local {\n  id i64\n  primary key (id)\n}\n";
            $model = RuntimeModel::build(RuntimeModel::parseSet(['app.dbs' => $owned], ['core.dbs' => $external]));
            $schema = new Schema($model->manifestText, $model->manifestHash, $model->externalText);

            for ($attempt = 0; $attempt < 2; $attempt++) {
                try {
                    $db->utils()->schema()->addTablesAndColumns($schema);
                    self::fail('external schema drift was accepted');
                } catch (OrmException $error) {
                    self::assertSame(Code::CONFIG, $error->code_);
                }
                self::assertSame($before, $pdo->query(
                    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' "
                    . 'ORDER BY type, name'
                )->fetchAll(\PDO::FETCH_ASSOC));
                self::assertSame($foreignKeysBefore, $pdo->query('PRAGMA foreign_keys')->fetchColumn());
            }
            $controls = array_values(array_filter(
                array_map(static fn($event): string => $event->kind, $events),
                static fn(string $kind): bool => in_array($kind, ['utility', 'begin', 'rollback'], true)
            ));
            self::assertSame(
                ['utility', 'begin', 'rollback', 'utility', 'utility', 'begin', 'rollback', 'utility'],
                $controls
            );
            $unsubscribe();
            $db->close();
        } finally {
            if (is_file($path)) {
                unlink($path);
            }
        }
    }

    public function testExistsEscapesUnderscoreInSqliteSchemaName(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'orm-schema-underscore-');
        self::assertIsString($path);
        try {
            $db = Orm::connect('sqlite:///' . $path, new Config());
            $pdo = $db->pdo();
            $pdo->exec('CREATE TABLE fooXbar__sample (id INTEGER)');
            $before = $pdo->query(
                "SELECT name, sql FROM sqlite_master WHERE type = 'table' "
                . "AND name NOT LIKE 'sqlite_%' ORDER BY name"
            )->fetchAll(\PDO::FETCH_ASSOC);
            $schema = $db->utils()->schema();

            for ($attempt = 0; $attempt < 2; $attempt++) {
                self::assertFalse($schema->exists('foo_bar'));
                self::assertSame($before, $pdo->query(
                    "SELECT name, sql FROM sqlite_master WHERE type = 'table' "
                    . "AND name NOT LIKE 'sqlite_%' ORDER BY name"
                )->fetchAll(\PDO::FETCH_ASSOC));
            }
            $db->close();
        } finally {
            if (is_file($path)) {
                unlink($path);
            }
        }
    }

    public function testAddTablesAndColumnsRollsBackWithoutCreatingInternalLockTable(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'orm-schema-rollback-');
        self::assertIsString($path);
        try {
            $db = Orm::connect('sqlite:///' . $path, new Config());
            $pdo = $db->pdo();
            $pdo->exec('CREATE TABLE owned (id TEXT NOT NULL PRIMARY KEY)');
            $events = [];
            $unsubscribe = $db->subscribe(static function ($event) use (&$events): void {
                $events[] = $event;
            });
            $before = $pdo->query(
                "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' "
                . 'ORDER BY type, name'
            )->fetchAll(\PDO::FETCH_ASSOC);
            $foreignKeysBefore = $pdo->query('PRAGMA foreign_keys')->fetchColumn();
            $owned = "dbspec 1 app\n\ntable owned {\n  id i64\n  primary key (id)\n}\n";
            $model = RuntimeModel::build(RuntimeModel::parseSet(['app.dbs' => $owned], []));
            $schema = new Schema($model->manifestText, $model->manifestHash, $model->externalText);

            for ($attempt = 0; $attempt < 2; $attempt++) {
                try {
                    $db->utils()->schema()->addTablesAndColumns($schema);
                    self::fail('an incompatible owned table was accepted');
                } catch (OrmException $error) {
                    self::assertSame(Code::SCHEMA_DIFFERS, $error->code_);
                }
                self::assertSame($before, $pdo->query(
                    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' "
                    . 'ORDER BY type, name'
                )->fetchAll(\PDO::FETCH_ASSOC));
                self::assertSame($foreignKeysBefore, $pdo->query('PRAGMA foreign_keys')->fetchColumn());
            }
            $controls = array_values(array_filter(
                array_map(static fn($event): string => $event->kind, $events),
                static fn(string $kind): bool => in_array($kind, ['utility', 'begin', 'rollback'], true)
            ));
            self::assertSame(
                ['utility', 'begin', 'rollback', 'utility', 'utility', 'begin', 'rollback', 'utility'],
                $controls
            );
            $unsubscribe();
            $db->close();
        } finally {
            if (is_file($path)) {
                unlink($path);
            }
        }
    }

    public function testSchemaMutationMethodsRejectObjectsThatAreNotSchema(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'orm-schema-type-');
        self::assertIsString($path);
        try {
            $db = Orm::connect('sqlite:///' . $path, new Config());
            $pdo = $db->pdo();
            $schema = $db->utils()->schema();
            $events = [];
            $unsubscribe = $db->subscribe(static function ($event) use (&$events): void {
                $events[] = $event;
            });
            $before = $pdo->query(
                "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' "
                . 'ORDER BY type, name'
            )->fetchAll(\PDO::FETCH_ASSOC);

            foreach (['register', 'install', 'addTablesAndColumns'] as $method) {
                for ($attempt = 0; $attempt < 2; $attempt++) {
                    try {
                        $schema->{$method}(new \stdClass());
                        self::fail("$method accepted an object that is not a Schema");
                    } catch (\TypeError $error) {
                        self::assertStringContainsString('Schema', $error->getMessage());
                    }
                    self::assertSame([], $events);
                    self::assertSame($before, $pdo->query(
                        "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' "
                        . 'ORDER BY type, name'
                    )->fetchAll(\PDO::FETCH_ASSOC));
                }
            }
            $unsubscribe();
            $db->close();
        } finally {
            if (is_file($path)) {
                unlink($path);
            }
        }
    }

    public function testNativeSchemaInspectionAndRegistration(): void
    {
        $class = new \ReflectionClass(SchemaUtils::class);
        self::assertTrue($class->isInternal());
        foreach (['register', 'install', 'addTablesAndColumns', 'exists', 'installed', 'empty'] as $method) {
            self::assertTrue($class->getMethod($method)->isInternal());
        }

        $path = tempnam(sys_get_temp_dir(), 'orm-schema-native-');
        self::assertIsString($path);
        try {
            $db = Orm::connect('sqlite:///' . $path, new Config());
            $schema = $db->utils()->schema();
            $events = [];
            self::assertTrue($schema->empty());
            self::assertFalse($schema->exists('bench'));
            self::assertFalse($schema->installed('bench', 'sample'));
            $schema->install(self::benchSharedSchema());
            $schema->install(\Polyspec\Orm\Tests\Model\schema());
            self::assertFalse($schema->exists('bench'));
            self::assertFalse($schema->installed('bench', 'author'));
            self::assertFalse($schema->empty());
            $schema->register(\Polyspec\Orm\Tests\Model\schema());
            $unsubscribe = $db->subscribe(static function ($event) use (&$events): void {
                $events[] = $event;
            });
            self::assertSame([], $schema->addTablesAndColumns(\Polyspec\Orm\Tests\Model\schema()));
            self::assertNotEmpty(array_filter($events, static fn($event): bool => $event->kind === 'schema'));
            $unsubscribe();
            $db->run(\Polyspec\Orm\StatementEvent::SCHEMA, [], null, 'CREATE TABLE bench__sample (id INTEGER)');
            self::assertTrue($schema->exists('bench'));
            self::assertTrue($schema->installed('bench', 'sample'));
            $initial = self::schema("dbspec 1 evolution\n\ntable evolving {\n  id i64\n  primary key (id)\n}\n");
            $schema->install($initial);
            $targetText = "dbspec 1 evolution\n\ntable evolving {\n  id i64\n  label varchar(32) null\n"
                . "  primary key (id)\n}\n\ntable added {\n  id i64\n  primary key (id)\n}\n";
            $target = self::schema($targetText);
            self::assertSame(['added', 'evolving.label'], $schema->addTablesAndColumns($target));

            $rollbackUnsubscribe = $db->subscribe(static function ($event): void {
                if ($event->kind === 'schema' && str_starts_with($event->sql, 'CREATE TABLE')) {
                    throw new \RuntimeException('stop schema installation');
                }
            });
            try {
                $schema->install(self::schema(
                    "dbspec 1 rollback_case\n\ntable rollback_probe {\n  id i64\n  primary key (id)\n}\n"
                ));
                self::fail('a schema event subscriber failure did not stop installation');
            } catch (\Polyspec\Orm\OrmException $error) {
                self::assertSame(\Polyspec\Orm\Code::SUBSCRIBER, $error->code_);
            } finally {
                $rollbackUnsubscribe();
            }
            $exists = $db->pdo()->query(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rollback_probe')"
            )->fetchColumn();
            self::assertSame(0, (int) $exists);
            $db->close();
        } finally {
            if (is_file($path)) {
                unlink($path);
            }
        }
    }

    private static function benchSharedSchema(): Schema
    {
        $path = dirname(__DIR__, 3) . '/contracts/fixtures/bench/bench_shared.dbs';
        $manifest = Dbspec::manifest(RuntimeModel::files([$path]))->manifest
            ?? throw new OrmException(Code::SCHEMA_INVALID, 'the shared benchmark schema does not parse');
        return new Schema($manifest->manifestText, $manifest->manifestHash);
    }

    private static function schema(string $text): Schema
    {
        $document = Dbspec::parse($text, [])->document
            ?? throw new OrmException(Code::SCHEMA_INVALID, 'the test schema does not parse');
        $manifest = Dbspec::manifest([$document])->manifest
            ?? throw new OrmException(Code::SCHEMA_INVALID, 'the test schema has no manifest');
        return new Schema($manifest->manifestText, $manifest->manifestHash);
    }
}
