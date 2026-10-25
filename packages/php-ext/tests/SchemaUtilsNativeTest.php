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
        $this->assertSchemaMutationRejected(
            'external',
            'CREATE TABLE shared (id BIGINT NOT NULL PRIMARY KEY)',
            "dbspec 1 app\n\nuse core { shared }\n\ntable local {\n  id i64\n  primary key (id)\n}\n",
            ['core.dbs' => "dbspec 1 core\n\ntable shared {\n  id i32\n  primary key (id)\n}\n"],
            Code::CONFIG,
            'external schema drift was accepted'
        );
    }

    // Requirements: INT-57.
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
        $this->assertSchemaMutationRejected(
            'rollback',
            'CREATE TABLE owned (id TEXT NOT NULL PRIMARY KEY)',
            "dbspec 1 app\n\ntable owned {\n  id i64\n  primary key (id)\n}\n",
            [],
            Code::SCHEMA_DIFFERS,
            'an incompatible owned table was accepted'
        );
    }

    public function testBeginSubscriberFailureRollsBackAnOpenedSqliteTransaction(): void
    {
        $this->assertSchemaBeginFailure(false);
    }

    public function testBeginAndRollbackSubscriberFailuresKeepBothCauses(): void
    {
        $this->assertSchemaBeginFailure(true);
    }

    private function assertSchemaBeginFailure(bool $failRollback): void
    {
        $path = '';
        try {
            [$db, $pdo, $before, $events] = self::openSqliteSchemaFailureFixture(
                'orm-schema-rollback-failure-',
                $path
            );
            $unsubscribe = $db->subscribe(static function ($event) use (&$events, $failRollback): void {
                $events[] = $event->kind . ':' . $event->sql;
                if ($event->kind === 'begin' && $event->sql === 'BEGIN IMMEDIATE') {
                    throw new \RuntimeException('begin observer failed');
                }
                if ($failRollback && $event->kind === 'rollback' && $event->sql === 'ROLLBACK') {
                    throw new \RuntimeException('rollback observer failed');
                }
            });

            try {
                $db->utils()->schema()->addTablesAndColumns(self::schema(
                    "dbspec 1 begin_failure\n\ntable sample {\n  id i64\n  primary key (id)\n}\n"
                ));
                self::fail('the BEGIN and ROLLBACK subscriber failures were ignored');
            } catch (OrmException $error) {
                if ($failRollback) {
                    self::assertSame(Code::ROLLBACK, $error->code_);
                    self::assertSame(
                        'ROLLBACK: transaction failed '
                        . '(SUBSCRIBER: statement event subscriber failed: begin observer failed) '
                        . 'and rollback failed '
                        . '(SUBSCRIBER: statement event subscriber failed: rollback observer failed)',
                        $error->getMessage()
                    );
                    self::assertSame(
                        'SUBSCRIBER: statement event subscriber failed: begin observer failed',
                        $error->getPrevious()?->getMessage()
                    );
                    self::assertSame(
                        'SUBSCRIBER: statement event subscriber failed: rollback observer failed',
                        $error->rollback?->getMessage()
                    );
                    self::assertSame('begin observer failed', $error->getPrevious()?->getPrevious()?->getMessage());
                    self::assertSame('rollback observer failed', $error->rollback?->getPrevious()?->getMessage());
                } else {
                    self::assertSame(Code::SUBSCRIBER, $error->code_);
                    self::assertSame('begin observer failed', $error->getPrevious()?->getMessage());
                }
            }

            self::assertSqliteCleanupState($pdo, $before, $events, true);
            $unsubscribe();
            $db->close();
        } finally {
            if (is_file($path)) {
                unlink($path);
            }
        }
    }

    public function testSqliteRestoreFailureKeepsThePrimaryFailureAsPrevious(): void
    {
        $path = '';
        try {
            [$db, $pdo, $before, $events] = self::openSqliteSchemaFailureFixture(
                'orm-schema-restore-failure-',
                $path
            );
            $unsubscribe = $db->subscribe(static function ($event) use (&$events): void {
                $events[] = $event->kind . ':' . $event->sql;
                if ($event->kind === 'begin' && $event->sql === 'BEGIN IMMEDIATE') {
                    throw new \RuntimeException('primary begin failure');
                }
                if ($event->kind === 'utility' && $event->sql === 'PRAGMA foreign_keys = ON') {
                    throw new \RuntimeException('foreign key restore failure');
                }
            });

            try {
                $db->utils()->schema()->addTablesAndColumns(self::schema(
                    "dbspec 1 restore_failure\n\ntable sample {\n  id i64\n  primary key (id)\n}\n"
                ));
                self::fail('the subscriber failures were ignored');
            } catch (OrmException $error) {
                self::assertSame(Code::SUBSCRIBER, $error->code_);
                $chain = [];
                for ($cause = $error; $cause !== null; $cause = $cause->getPrevious()) {
                    $chain[] = $cause->getMessage();
                }
                self::assertSame([
                    'SUBSCRIBER: statement event subscriber failed: foreign key restore failure',
                    'foreign key restore failure',
                    'SUBSCRIBER: statement event subscriber failed: primary begin failure',
                    'primary begin failure',
                ], $chain);
            }

            self::assertSqliteCleanupState($pdo, $before, $events, false);
            $unsubscribe();
            $db->close();
        } finally {
            if (is_file($path)) {
                unlink($path);
            }
        }
    }

    public function testBeginInspectionFailureReplacesThePrimaryAndRestoresForeignKeys(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'orm-schema-inspection-failure-');
        self::assertIsString($path);
        try {
            $db = Orm::connect('sqlite:///' . $path, new Config());
            $pdo = new class ('sqlite:' . $path) extends \PDO {
                public bool $failInspection = false;

                public function inTransaction(): bool
                {
                    if ($this->failInspection) {
                        throw new \RuntimeException('transaction inspection failed');
                    }
                    return parent::inTransaction();
                }
            };
            $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
            $pdo->exec('PRAGMA foreign_keys = ON');
            $state = (new \ReflectionProperty(\Polyspec\Orm\Db::class, 'state'))->getValue($db);
            $state->pdo = $pdo;
            $before = self::sqliteSchemaSnapshot($pdo);
            $events = [];
            $unsubscribe = $db->subscribe(static function ($event) use (&$events, $pdo): void {
                $events[] = $event->kind . ':' . $event->sql;
                if ($event->kind === 'begin' && $event->sql === 'BEGIN IMMEDIATE') {
                    $pdo->failInspection = true;
                    throw new \RuntimeException('begin observer failed');
                }
            });

            try {
                $db->utils()->schema()->addTablesAndColumns(self::schema(
                    "dbspec 1 inspection_failure\n\ntable sample {\n  id i64\n  primary key (id)\n}\n"
                ));
                self::fail('the BEGIN and inspection failures were ignored');
            } catch (\RuntimeException $error) {
                self::assertSame('transaction inspection failed', $error->getMessage());
            }

            $pdo->failInspection = false;
            self::assertTrue($pdo->inTransaction());
            self::assertSame(0, (int) $pdo->query('PRAGMA foreign_keys')->fetchColumn());
            self::assertSame($before, self::sqliteSchemaSnapshot($pdo));
            self::assertSame([
                'utility:PRAGMA foreign_keys = OFF',
                'begin:BEGIN IMMEDIATE',
                'utility:PRAGMA foreign_keys = ON',
            ], $events);
            $pdo->exec('ROLLBACK');
            $pdo->exec('PRAGMA foreign_keys = ON');
            self::assertSame(1, (int) $pdo->query('PRAGMA foreign_keys')->fetchColumn());
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
            $unsubscribe = self::collectEvents($db, $events);
            $before = self::sqliteSchemaSnapshot($pdo);

            foreach (['register', 'install', 'addTablesAndColumns'] as $method) {
                for ($attempt = 0; $attempt < 2; $attempt++) {
                    try {
                        $schema->{$method}(new \stdClass());
                        self::fail("$method accepted an object that is not a Schema");
                    } catch (\TypeError $error) {
                        self::assertStringContainsString('Schema', $error->getMessage());
                    }
                    self::assertSame([], $events);
                    self::assertSame($before, self::sqliteSchemaSnapshot($pdo));
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
        $document = Dbspec::parse(
            "dbspec 1 manifest_test\n\ntable users {\n  id i64\n  primary key (id)\n}\n",
            []
        )->document;
        self::assertNotNull($document);
        $manifest = Dbspec::manifest([$document, $document]);
        self::assertNull($manifest->manifest);
        self::assertSame(
            [['name.duplicate', 1, 10]],
            array_map(
                static fn($diagnostic): array => [$diagnostic->rule, $diagnostic->line, $diagnostic->column],
                $manifest->diagnostics
            )
        );

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
            $unsubscribe = self::collectEvents($db, $events);
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

    public function testSchemaIdentifierRejectsInvalidCharactersBeforeQuery(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'orm-schema-identifier-');
        self::assertIsString($path);
        $db = null;
        $unsubscribe = null;
        try {
            $db = Orm::connect('sqlite:///' . $path, new Config());
            $events = [];
            $unsubscribe = self::collectEvents($db, $events);
            try {
                $db->utils()->schema()->exists('bad-name');
                self::fail('an invalid schema identifier was accepted');
            } catch (OrmException $error) {
                self::assertSame(Code::CONFIG, $error->code_);
                self::assertSame('CONFIG: identifier bad-name is invalid', $error->getMessage());
            }
            self::assertSame([], $events);
        } finally {
            if ($unsubscribe !== null) {
                $unsubscribe();
            }
            if ($db !== null) {
                $db->close();
            }
            if (is_file($path)) {
                unlink($path);
            }
        }
    }

    /**
     * @param array<string, string> $externalFiles
     */
    private function assertSchemaMutationRejected(
        string $scenario,
        string $createTable,
        string $ownedText,
        array $externalFiles,
        string $errorCode,
        string $failureMessage
    ): void {
        $path = tempnam(sys_get_temp_dir(), "orm-schema-$scenario-");
        self::assertIsString($path);
        try {
            $db = Orm::connect('sqlite:///' . $path, new Config());
            $pdo = $db->pdo();
            $pdo->exec($createTable);
            $events = [];
            $unsubscribe = self::collectEvents($db, $events);
            $before = self::sqliteSchemaSnapshot($pdo);
            $foreignKeysBefore = $pdo->query('PRAGMA foreign_keys')->fetchColumn();
            $model = RuntimeModel::build(RuntimeModel::parseSet(['app.dbs' => $ownedText], $externalFiles));
            $schema = new Schema($model->manifestText, $model->manifestHash, $model->externalText);

            for ($attempt = 0; $attempt < 2; $attempt++) {
                try {
                    $db->utils()->schema()->addTablesAndColumns($schema);
                    self::fail($failureMessage);
                } catch (OrmException $error) {
                    self::assertSame($errorCode, $error->code_);
                }
                self::assertSame($before, self::sqliteSchemaSnapshot($pdo));
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

    /**
     * @param-out string $path
     * @return array{\Polyspec\Orm\Db, \PDO, list<array{type: string, name: string, sql: ?string}>, list<string>}
     */
    private static function openSqliteSchemaFailureFixture(string $prefix, string &$path): array
    {
        $path = tempnam(sys_get_temp_dir(), $prefix);
        self::assertIsString($path);
        $db = Orm::connect('sqlite:///' . $path, new Config());
        return [$db, $db->pdo(), self::sqliteSchemaSnapshot($db->pdo()), []];
    }

    /**
     * @param list<array{type: string, name: string, sql: ?string}> $before
     * @param list<string> $events
     */
    private static function assertSqliteCleanupState(
        \PDO $pdo,
        array $before,
        array $events,
        bool $assertForeignKeys,
    ): void {
        self::assertFalse($pdo->inTransaction());
        if ($assertForeignKeys) {
            self::assertSame(1, (int) $pdo->query('PRAGMA foreign_keys')->fetchColumn());
        }
        self::assertSame($before, self::sqliteSchemaSnapshot($pdo));
        self::assertSame([
            'utility:PRAGMA foreign_keys = OFF',
            'begin:BEGIN IMMEDIATE',
            'rollback:ROLLBACK',
            'utility:PRAGMA foreign_keys = ON',
        ], $events);
    }

    /**
     * @param list<object> $events
     */
    private static function collectEvents(\Polyspec\Orm\Db $db, array &$events): \Closure
    {
        return $db->subscribe(static function ($event) use (&$events): void {
            $events[] = $event;
        });
    }

    /** @return list<array{type: string, name: string, sql: ?string}> */
    private static function sqliteSchemaSnapshot(\PDO $pdo): array
    {
        return $pdo->query(
            "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
        )->fetchAll(\PDO::FETCH_ASSOC);
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
