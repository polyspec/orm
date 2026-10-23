<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;

final class RuntimeModelGeneratedFixture
{
    public static function meta(): array
    {
        return [
            'entity' => 'account', 'table' => 'users', 'pk' => ['id'], 'identity' => 'id',
            'updated' => '', 'soft_delete' => '', 'aes_version' => '', 'audit' => '', 'audit_record' => '',
            'columns' => [
                'id' => ['name' => 'id', 'type' => 'i64', 'nullable' => false, 'default' => false, 'default_now' => false, 'select' => true, 'codec' => [], 'blind_index' => '', 'pk' => true, 'foreign_key' => false],
                'title' => ['name' => 'title', 'type' => 'varchar', 'nullable' => false, 'default' => false, 'default_now' => false, 'select' => false, 'codec' => [], 'blind_index' => '', 'pk' => false, 'foreign_key' => false, 'length' => 64],
                'amount' => ['name' => 'amount', 'type' => 'decimal', 'nullable' => true, 'default' => true, 'default_now' => false, 'select' => true, 'codec' => [], 'blind_index' => '', 'pk' => false, 'foreign_key' => false, 'precision' => 12, 'scale' => 2],
            ],
            'unique' => ['uq_title' => ['title']], 'indexes' => ['ix_title' => ['title']],
            'manifest_hash' => 'sha256:generated-fixture',
        ];
    }
}

final class RuntimeModelBadGeneratedFixture
{
    public static function meta(): array
    {
        $meta = RuntimeModelGeneratedFixture::meta();
        $meta['columns']['id']['type'] = 'i32';
        return $meta;
    }
}

#[Small]
final class RuntimeModelTest extends TestCase
{
    private const string OWNED = <<<'DBSPEC'
dbspec 1 app

table users {
  id i64 identity
  title varchar(64)
  amount decimal(12,2) null default 0.00
  primary key (id)
  unique uq_title (title)
  index ix_title (title)
  settings {
    entity account
    select explicit title
  }
}
DBSPEC;

    public function testNativeOriginAndCanonicalMetadata(): void
    {
        self::assertTrue((new \ReflectionClass(RuntimeModel::class))->isInternal());
        $docs = RuntimeModel::parse(['source.dbs' => self::OWNED]);
        self::assertSame(['app'], array_map(static fn($d) => $d->name, $docs));
        $model = RuntimeModel::build($docs);
        self::assertSame('account', $model->entity('account')['entity']);
        self::assertSame(['id'], $model->entity('account')['pk']);
        self::assertSame(12, $model->entity('account')['columns']['amount']['precision']);
        self::assertSame(2, $model->entity('account')['columns']['amount']['scale']);
        self::assertFalse($model->entity('account')['columns']['title']['select']);
        self::assertSame(['document 0' => self::OWNED . "\n"], RuntimeModel::splitManifest($model->manifestText));
        self::assertSame($model->entities, RuntimeModel::build(RuntimeModel::loadSet($model->manifestText, $model->externalText))->entities);
    }

    public function testOwnedAndExternalManifestEntities(): void
    {
        $external = <<<'DBSPEC'
dbspec 1 core

table shared {
  id i64
  label varchar(32)
  primary key (id)
  unique uq_label (label)
  index ix_label (label)
}
DBSPEC;
        $owned = <<<'DBSPEC'
dbspec 1 app

use core { shared }

table local {
  id i64 identity
  shared_id i64
  primary key (id)
  index ix_shared_id (shared_id)
  foreign key fk_shared (shared_id) references shared (id) on delete restrict on update restrict
}
DBSPEC;
        $docs = RuntimeModel::parseSet(['app.dbs' => $owned], ['core.dbs' => $external]);
        self::assertCount(2, $docs);
        self::assertFalse($docs[0]->external);
        self::assertTrue($docs[1]->external);
        $model = RuntimeModel::build($docs);
        self::assertTrue($model->entities['shared']['external']);
        self::assertSame([], $model->entities['shared']['indexes']);
        self::assertSame(['uq_label' => ['label']], $model->entities['shared']['unique']);
        self::assertTrue($model->entities['local']['columns']['shared_id']['foreign_key']);
        self::assertSame($model->manifestHash, 'sha256:' . hash('sha256', $model->manifestText . $model->externalText));
    }

    public function testSetAndFilesUseTheNativeSetReaderAndReadBytesPath(): void
    {
        $root = dirname(__DIR__, 3);
        $set = "$root/contracts/fixtures/bench/dbspec-set.json";
        $fromSet = RuntimeModel::build(RuntimeModel::set($set));
        $dir = "$root/contracts/fixtures/bench";
        $fromFiles = RuntimeModel::build(RuntimeModel::files(
            ["$dir/bench.dbs", "$dir/bench_reader.dbs"],
            ["$dir/bench_shared.dbs"],
        ));
        self::assertSame($fromSet->manifestText, $fromFiles->manifestText);
        self::assertSame($fromSet->externalText, $fromFiles->externalText);
        self::assertSame($fromSet->entities, $fromFiles->entities);
    }

    public function testFileReadConfigurationErrorKeepsItsOriginalCause(): void
    {
        $path = sys_get_temp_dir() . '/polyspec-runtime-model-missing-' . bin2hex(random_bytes(8));
        try {
            RuntimeModel::files([$path]);
            self::fail('expected unreadable file');
        } catch (OrmException $e) {
            self::assertSame(Code::CONFIG, $e->code_);
            self::assertInstanceOf(\RuntimeException::class, $e->getPrevious());
            self::assertStringContainsString($path, $e->getMessage());
        }
    }

    public function testParseAndManifestFailuresKeepOrmCodes(): void
    {
        try {
            RuntimeModel::parse(['broken.dbs' => "not a dbspec\n"]);
            self::fail('expected invalid schema');
        } catch (OrmException $e) {
            self::assertSame(Code::SCHEMA_INVALID, $e->code_);
            self::assertStringContainsString('broken.dbs:', $e->getMessage());
        }
        try {
            RuntimeModel::parse([0 => "not a dbspec\n"]);
            self::fail('expected numeric-label schema failure');
        } catch (OrmException $e) {
            self::assertSame(Code::SCHEMA_INVALID, $e->code_);
            self::assertStringContainsString('0:', $e->getMessage());
        }
        try {
            RuntimeModel::splitManifest('invalid');
            self::fail('expected invalid manifest');
        } catch (OrmException $e) {
            self::assertSame(Code::SCHEMA_INVALID, $e->code_);
            self::assertStringContainsString('manifest text does not start with a dbspec header', $e->getMessage());
        }
    }

    public function testFromModelsAcceptsExactMetadataAndReportsFirstChangedPath(): void
    {
        $model = RuntimeModel::fromModels('sha256:declared', RuntimeModel::build(RuntimeModel::parse(['source.dbs' => self::OWNED]))->manifestText, [RuntimeModelGeneratedFixture::class]);
        self::assertSame('sha256:declared', $model->manifestHash);
        self::assertSame('account', $model->entities['account']['entity']);
        try {
            RuntimeModel::fromModels('sha256:declared', $model->manifestText, [RuntimeModelBadGeneratedFixture::class]);
            self::fail('expected metadata mismatch');
        } catch (OrmException $e) {
            self::assertSame(Code::CONFIG, $e->code_);
            self::assertStringContainsString('differs from its manifest at columns.id.type', $e->getMessage());
        }
    }

    public function testColumnPredicatesUseDeclaredCodecAndType(): void
    {
        self::assertSame(['ordered_json', 'serialize', 'yaml', 'gz', 'base64'], RuntimeModel::STYLED_STAGES);
        self::assertSame(['aes', 'hex', 'ip'], RuntimeModel::HOST_STAGES);
        self::assertTrue(RuntimeModel::styled(['codec' => ['ordered_json']]));
        self::assertTrue(RuntimeModel::encrypted(['codec' => ['aes']]));
        self::assertTrue(RuntimeModel::numeric(['codec' => [], 'type' => 'decimal']));
        self::assertFalse(RuntimeModel::numeric(['codec' => ['hex'], 'type' => 'i64']));
    }
}
