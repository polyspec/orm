<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Code;
use Polyspec\Orm\Model;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Registry;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Schema;
use PHPUnit\Framework\TestCase;

final class RegistrySchemaNativeTest extends TestCase
{
    public function testNativeOriginsAndReadonlySchemaRoundTrip(): void
    {
        self::assertTrue((new \ReflectionClass(Registry::class))->isInternal());
        self::assertTrue((new \ReflectionClass(Schema::class))->isInternal());
        $text = "dbspec 1 registry_schema_native\n\ntable item {\n  id i64 identity\n  primary key (id)\n}\n";
        $external = "";
        $hash = 'sha256:' . hash('sha256', $text . $external);
        $schema = new Schema($text, $hash, $external);
        $schema->verify();
        self::assertSame($text, $schema->manifestText);
        self::assertSame($hash, $schema->manifestHash);
        self::assertSame($external, $schema->externalText);
        self::assertSame($text, (clone $schema)->manifestText);
        self::assertCount(1, $schema->documents());
        $property = new \ReflectionProperty(Schema::class, 'manifestHash');
        self::assertTrue($property->isReadOnly());
    }

    public function testHashFailureIsAtomicAndHasSourceCode(): void
    {
        $text = "dbspec 1 registry_schema_bad\n\ntable item {\n  id i64 identity\n  primary key (id)\n}\n";
        $hash = 'sha256:' . hash('sha256', $text);
        $bad = new Schema($text . "# changed\n", $hash);
        try {
            $bad->verify();
            self::fail('invalid schema hash was accepted');
        } catch (OrmException $e) {
            self::assertSame(Code::CONFIG, $e->code_);
            self::assertStringContainsString('invalid schema manifest', $e->getMessage());
        }
        $before = Registry::loaded($hash);
        try {
            Registry::generated($hash, $text . "# changed\n");
            self::fail('invalid generated hash was accepted');
        } catch (OrmException $e) {
            self::assertSame(Code::SCHEMA_HASH_MISMATCH, $e->code_);
        }
        self::assertSame($before, Registry::loaded($hash));
    }

    public function testPerManifestRuntimeCacheAndInvalidationAfterRegister(): void
    {
        $text = "dbspec 1 registry_runtime_cache\n\ntable item {\n  id i64 identity\n  primary key (id)\n}\n\ntable other {\n  id i64 identity\n  primary key (id)\n}\n";
        $manifest = RuntimeModel::build(RuntimeModel::loadSet($text, ''));
        $hash = $manifest->manifestHash;
        Registry::generated($hash, $manifest->manifestText, '');
        self::assertTrue(Registry::loaded($hash));
        self::assertSame($manifest->manifestText, Registry::manifestText($hash));
        $emptyModelsSnapshot = Registry::models($hash);
        self::assertSame([], $emptyModelsSnapshot);
        $first = Registry::model($hash);
        $firstEntities = $first->entities;
        self::assertSame($first, Registry::model($hash));

        $meta = $manifest->entities['item'] + ['manifest_hash' => $hash];
        $modelClass = new class extends Model {
            public static array $testMeta = [];
            public static function meta(): array { return self::$testMeta; }
        };
        $modelClass::$testMeta = $meta;
        Registry::register($modelClass::class);
        self::assertSame([], $emptyModelsSnapshot);
        $otherMeta = $manifest->entities['other'] + ['manifest_hash' => $hash];
        $otherClass = new class extends Model {
            public static array $testMeta = [];
            public static function meta(): array { return self::$testMeta; }
        };
        $otherClass::$testMeta = $otherMeta;
        $modelsSnapshot = Registry::models($hash);
        Registry::register($otherClass::class);
        self::assertSame([$modelClass::class, $otherClass::class], array_values(Registry::models($hash)));
        self::assertSame([], $emptyModelsSnapshot);
        self::assertSame([$modelClass::class], array_values($modelsSnapshot));
        $second = Registry::model($hash);
        self::assertNotSame($first, $second);
        self::assertSame($meta, $modelClass::meta(), 'fromModels does not mutate generated metadata returned by meta()');
        self::assertSame($firstEntities, $first->entities);
        self::assertSame($second, Registry::model($hash));

        $otherText = "dbspec 1 registry_runtime_other\n\ntable other {\n  id i64 identity\n  primary key (id)\n}\n";
        $other = RuntimeModel::build(RuntimeModel::loadSet($otherText, ''));
        Registry::generated($other->manifestHash, $other->manifestText, '');
        self::assertTrue(Registry::loaded($other->manifestHash));
        $otherRuntime = Registry::model($other->manifestHash);
        self::assertNotSame($hash, $other->manifestHash);
        self::assertNotSame($otherRuntime, Registry::model($hash));

        $conflict = new class extends Model {
            public static array $testMeta = [];
            public static function meta(): array { return self::$testMeta; }
        };
        $conflict::$testMeta = $meta;
        self::assertSame($meta, $conflict::meta());
        $beforeConflictModels = Registry::models($hash);
        $beforeConflictRuntime = Registry::model($hash);
        try {
            Registry::register($conflict::class);
            self::fail('a second class for one manifest entity was accepted');
        } catch (OrmException $e) {
            self::assertSame(Code::CONFIG, $e->code_);
            self::assertStringContainsString('generated as both', $e->getMessage());
        }
        self::assertSame(array_values($beforeConflictModels), array_values(Registry::models($hash)));
        self::assertSame($beforeConflictRuntime, Registry::model($hash));
        self::assertSame($otherRuntime, Registry::model($other->manifestHash));
    }
}
