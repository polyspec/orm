<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// The runtime model of the bench set contracts/fixtures/bench/dbspec-set.json (docs/spec/dbspec.md "Runtime model"):
// codec value types, the generated models
// and their manifest hash, i16 fields, and a connection configuration without
// a schema path. Database behavior is in RuntimeDbTest.php.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/RuntimeModelTest.php

use Closure;
use ReflectionMethod;
use RuntimeException;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Engine;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Registry;
use Polyspec\Orm\RuntimeModel;

#[Small]
final class RuntimeModelTest extends TestCase
{
    private static function bench(): RuntimeModel
    {
        return RuntimeModel::build(
            RuntimeModel::set(dirname(__DIR__, 3) . '/contracts/fixtures/bench/dbspec-set.json')
        );
    }

    private static function errorCode(Closure $fn): string
    {
        try {
            $fn();
        } catch (OrmException $e) {
            return $e->code_;
        }
        return 'no error';
    }

    // Requirements: DSL-160.
    public function testNewOutputNameRejectsAStoredColumn(): void
    {
        $author = new Author();
        self::assertSame('CONFIG', self::errorCode(fn () => $author->newName('alias')));
        self::assertSame($author, $author->setName('stored'));
    }

    // Requirements: DBS-103, DBS-104, DBS-111, DBS-120.
    public function testGeneratedModelsCarryTheManifestHashAndTheModel(): void
    {
        $root = dirname(__DIR__, 3);
        $bench = self::bench();
        $manifest = Dbspec::manifest(RuntimeModel::set("$root/contracts/fixtures/bench/dbspec-set.json"))->manifest;
        $hash = Author::meta()['manifest_hash'];
        self::assertTrue($hash === $manifest->manifestHash, "manifest hash $hash");
        self::assertTrue(str_starts_with($hash, 'sha256:'), 'manifest hash form');
        self::assertTrue(Registry::manifestText($hash) === $manifest->manifestText, 'manifest text');
        self::assertTrue(
            Registry::model($hash)->entities === $bench->entities,
            'generated model differs from the document model'
        );
    }

    public function testAGeneratedModelAgreesWithItsManifestWhateverItsKeyOrder(): void
    {
        // The unique keys and indexes are declared out of name order; the manifest text sorts them by name.
        $source = "dbspec 1 order\n\ntable item {\n  id i64 identity\n  b i32\n  a i32\n  primary key (id)\n  unique "
            . "uq_b (b)\n  unique uq_a (a)\n  index ix_b (b)\n  index ix_a (a)\n}\n";
        // orm-gen builds the meta from the documents (OrmGen gen: RuntimeModel::build of the set).
        $model = RuntimeModel::build(RuntimeModel::loadSet($source, ''));
        $meta = $model->entities['item'] + ['manifest_hash' => $model->manifestHash];
        $generated = new class extends \Polyspec\Orm\Model {
            /** @var array<string, mixed> */
            public static array $meta = [];
            public static function meta(): array
            {
                return self::$meta;
            }
        };
        $generated::$meta = $meta;
        $runtime = RuntimeModel::fromModels($model->manifestHash, $model->manifestText, [$generated::class], '');
        self::assertTrue(
            $runtime->entities['item']['unique'] === ['uq_a' => ['a'], 'uq_b' => ['b']],
            'the unique keys in name order'
        );
    }

    // Requirements: DBS-104, DBS-111, DBS-120.
    public function testAGeneratedModelThatItsManifestContradictsIsRefused(): void
    {
        // A model generated before orm-gen wrote the varchar length: its meta() lacks columns.name.length.
        $stale = new class extends \Polyspec\Orm\Model {
            public static function meta(): array
            {
                $meta = Author::meta();
                unset($meta['columns']['name']['length']);
                return $meta;
            }
        };
        $hash = Author::meta()['manifest_hash'];
        $text = Registry::manifestText($hash);
        self::assertTrue(
            array_keys(Registry::model($hash)->entities) === array_keys(self::bench()->entities),
            'entity order follows the manifest'
        );
        self::assertTrue(
            RuntimeModel::fromModels(
                $hash,
                $text,
                [Author::class],
                \Polyspec\Orm\Tests\Model\EXTERNAL_TEXT
            )->entities['author'] === self::bench()->entities['author'],
            'a current model is taken'
        );
        $message = '';
        try {
            RuntimeModel::fromModels($hash, $text, [$stale::class], \Polyspec\Orm\Tests\Model\EXTERNAL_TEXT);
        } catch (OrmException $e) {
            self::assertTrue($e->code_ === Code::CONFIG, "code {$e->code_}");
            $message = $e->getMessage();
        }
        self::assertTrue(
            str_contains($message, $stale::class) && str_contains($message, 'entity author'),
            "names the class and the entity: $message"
        );
        self::assertTrue(
            str_contains($message, 'columns.name.length') && str_contains($message, 'orm-gen gen'),
            "names the field and the command: $message"
        );
    }

    // Requirements: DBS-104, DBS-111, DBS-120.
    public function testGeneratedFilesAreCurrent(): void
    {
        $root = dirname(__DIR__, 3);
        [$code, $out, $err] = OrmGenTestSupport::run([
            'gen', '--set', "$root/contracts/fixtures/bench/dbspec-set.json", '--out', "$root/packages/php/gen",
            '--namespace', 'Polyspec\\Orm\\Tests\\Model', '--check'
        ]);
        self::assertTrue($code === 0, trim("$out\n$err"));
    }

    // Requirements: DBS-116.
    public function testCodecValueTypes(): void
    {
        $type = static fn(string $method): string => (string) (
            new ReflectionMethod(Author::class, $method)
        )->getReturnType();
        foreach (['getJsonSetting', 'getJsonsTags', 'getSerializeData', 'getGzExtend', 'getBase64Extra'] as $m) {
            self::assertTrue($type($m) === 'Polyspec\\Orm\\StyledValue', "$m returns " . $type($m));
        }
        foreach (['getAesHexEmail', 'getIp', 'getPrice', 'getDescription'] as $m) {
            self::assertTrue($type($m) === '?string', "$m returns " . $type($m));
        }
        self::assertTrue($type('getTargetClubReaderCount') === 'int' && $type('getIsClose') === 'bool', 'scalar types');
        self::assertTrue($type('getCreatedTs') === 'DateTimeImmutable', 'datetime type');
    }

    public function testAColumnWhoseConditionMethodIsAModelMethodIsRefused(): void
    {
        // jsonText is a public static method of Model. A column json_text would generate an instance method of that
        // name, which PHP refuses when the model class loads, so generation refuses the column instead.
        $doc = "dbspec 1 small\n\ntable small_value {\n  seq i64 identity\n  json_text i32\n  primary key (seq)\n}\n";
        $out = sys_get_temp_dir() . '/orm-php-runtime-json-text-' . getmypid();
        $message = '';
        try {
            generateModels(['small.dbs' => $doc], "$out-source", $out, 'Polyspec\\Orm\\Tests\\Small');
        } catch (RuntimeException $e) {
            $message = $e->getMessage();
        }
        if (is_dir($out)) {
            array_map('unlink', glob("$out/*.php") ?: []);
            rmdir($out);
        }
        array_map('unlink', glob("$out-source/*") ?: []);
        is_dir("$out-source") && rmdir("$out-source");
        self::assertTrue(
            str_contains($message, 'the condition method jsonText is also the model method jsonText'),
            "refused: $message"
        );
    }

    // Requirements: DBS-119.
    public function testConfigurationWithoutASchemaPath(): void
    {
        $config = new Config(aesKey: 'k');
        self::assertTrue($config->aesKey === 'k', 'config');
        self::assertTrue(!property_exists($config, 'schemaPath'), 'schemaPath property');
        self::assertTrue(self::errorCode(fn() => new Config(aesVersion: 0)) === Code::CONFIG, 'invalid config');
    }

    // Requirements: DBS-104, DBS-111, DBS-120.
    public function testRequestsCarryTheManifestHash(): void
    {
        $bench = self::bench();
        self::assertTrue(
            array_keys(Registry::model($bench->manifestHash)->entities) === array_keys($bench->entities),
            'entity order follows the manifest'
        );
        $engine = new Engine($bench, 'sqlite', 4);
        $ir = [
            'ir_version' => 1,
            'manifest_hash' => 'sha256:00',
            'kind' => 'all',
            'entity' => 'service',
            'n_params' => 0
        ];
        self::assertTrue(
            self::errorCode(fn() => $engine->compile($ir)) === Code::SCHEMA_HASH_MISMATCH,
            'other manifest hash'
        );
        $ir['manifest_hash'] = $bench->manifestHash;
        self::assertTrue($engine->compile($ir)['manifest_hash'] === $bench->manifestHash, 'plan manifest hash');
    }
}
