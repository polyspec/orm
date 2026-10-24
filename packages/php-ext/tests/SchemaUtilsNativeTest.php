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
