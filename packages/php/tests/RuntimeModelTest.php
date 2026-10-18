<?php
declare(strict_types=1);
// The runtime model of the bench set contracts/fixtures/bench/dbspec-set.json (docs/dbspec.md "Runtime model"):
// entities, the default select set, codec value types, the generated models
// and their manifest hash, i16 fields, and a connection configuration without
// a schema path. Database behavior is in RuntimeDbTest.php.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/RuntimeModelTest.php

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Engine;
use Polyspec\Orm\Generator;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Registry;
use Polyspec\Orm\RuntimeModel;

#[Small]
final class RuntimeModelTest extends TestCase
{
    private static function bench(): RuntimeModel
    {
        return RuntimeModel::build(RuntimeModel::set(dirname(__DIR__, 3) . '/contracts/fixtures/bench/dbspec-set.json'));
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

    public function test_entities_in_document_order(): void
    {
        $bench = self::bench();
        $want = ['author', 'user', 'service', 'service_region', 'service_member', 'composite_account', 'composite_membership', 'soft_record', 'soft_link', 'account', 'project', 'account_project', 'task', 'hex_cell', 'time_cell', 'clock_cell', 'day_cell', 'upsert_cell', 'uuid_cell', 'bind_cell', 'audit_record', 'audited_note', 'audited_note_history', 'note_reader', 'shared_note'];
        self::assertTrue(array_keys($bench->entities) === $want, 'entities ' . implode(',', array_keys($bench->entities)));
        $author = $bench->entities['author'];
        self::assertTrue($author['identity'] === 'seq' && $author['pk'] === ['seq'], 'author keys');
        self::assertTrue($author['updated'] === 'updated_ts' && $author['aes_version'] === 'aes_key_version', 'author settings');
        self::assertTrue($bench->entities['soft_record']['soft_delete'] === 'deleted_at', 'soft delete setting');
        self::assertTrue($author['columns']['aes_hex_email']['blind_index'] === 'email_blind_index', 'blind index setting');
        self::assertTrue($author['columns']['json_setting']['codec'] === ['ordered_json'], 'ordered_json codec');
    }

    public function test_default_select_set_excludes_only_select_explicit(): void
    {
        $bench = self::bench();
        $selected = [];
        foreach ($bench->entities['author']['columns'] as $name => $c) {
            if ($c['select']) {
                $selected[] = $name;
            }
        }
        $explicit = ['description', 'email_blind_index', 'phone_blind_index', 'ip', 'gz_extend', 'json_setting', 'jsons_tags', 'base64_extra', 'serialize_data', 'aes_key_version'];
        $want = array_values(array_diff(array_keys($bench->entities['author']['columns']), $explicit));
        self::assertTrue($selected === $want, 'selected ' . implode(',', $selected));
    }

    public function test_generated_models_carry_the_manifest_hash_and_the_model(): void
    {
        $root = dirname(__DIR__, 3);
        $bench = self::bench();
        $manifest = Dbspec::manifest(RuntimeModel::set("$root/contracts/fixtures/bench/dbspec-set.json"))->manifest;
        $hash = Author::meta()['manifest_hash'];
        self::assertTrue($hash === $manifest->manifestHash, "manifest hash $hash");
        self::assertTrue(str_starts_with($hash, 'sha256:'), 'manifest hash form');
        self::assertTrue(Registry::manifestText($hash) === $manifest->manifestText, 'manifest text');
        self::assertTrue(Registry::model($hash)->entities === $bench->entities, 'generated model differs from the document model');
    }

    public function test_a_generated_model_that_its_manifest_contradicts_is_refused(): void
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
        self::assertTrue(RuntimeModel::fromModels($hash, $text, [Author::class], \Polyspec\Orm\Tests\Model\EXTERNAL_TEXT)->entities['author'] === self::bench()->entities['author'], 'a current model is taken');
        $message = '';
        try {
            RuntimeModel::fromModels($hash, $text, [$stale::class], \Polyspec\Orm\Tests\Model\EXTERNAL_TEXT);
        } catch (OrmException $e) {
            self::assertTrue($e->code_ === Code::CONFIG, "code {$e->code_}");
            $message = $e->getMessage();
        }
        self::assertTrue(str_contains($message, $stale::class) && str_contains($message, 'entity author'), "names the class and the entity: $message");
        self::assertTrue(str_contains($message, 'columns.name.length') && str_contains($message, 'orm-gen gen'), "names the field and the command: $message");
    }

    public function test_generated_files_are_current(): void
    {
        $root = dirname(__DIR__, 3);
        $bench = self::bench();
        $lines = Generator::check($bench, "$root/packages/php/gen", 'Polyspec\\Orm\\Tests\\Model');
        self::assertTrue($lines === [], implode("\n", $lines));
    }

    public function test_codec_value_types(): void
    {
        $type = static fn(string $method): string => (string) (new ReflectionMethod(Author::class, $method))->getReturnType();
        foreach (['getJsonSetting', 'getJsonsTags', 'getSerializeData', 'getGzExtend', 'getBase64Extra'] as $m) {
            self::assertTrue($type($m) === 'Polyspec\\Orm\\StyledValue', "$m returns " . $type($m));
        }
        foreach (['getAesHexEmail', 'getIp', 'getPrice', 'getDescription'] as $m) {
            self::assertTrue($type($m) === '?string', "$m returns " . $type($m));
        }
        self::assertTrue($type('getTargetClubReaderCount') === 'int' && $type('getIsClose') === 'bool', 'scalar types');
        self::assertTrue($type('getCreatedTs') === 'DateTimeImmutable', 'datetime type');
    }

    public function test_i16_field(): void
    {
        $root = dirname(__DIR__, 3);
        $doc = "dbspec 1 small\n\ntable small_value {\n  seq i64 identity\n  level i16\n  rank i16 null\n  primary key (seq)\n}\n";
        $model = RuntimeModel::build(RuntimeModel::parse(['small.dbs' => $doc]));
        self::assertTrue($model->entities['small_value']['columns']['level']['type'] === 'i16', 'i16 type');
        $out = sys_get_temp_dir() . '/orm-php-runtime-i16-' . getmypid();
        Generator::generate($model, $out, 'Polyspec\\Orm\\Tests\\Small');
        $body = (string) file_get_contents("$out/SmallValue.php");
        array_map('unlink', glob("$out/*.php"));
        rmdir($out);
        self::assertTrue(str_contains($body, 'public function getLevel(): int') && str_contains($body, 'public function getRank(): ?int'), 'i16 accessors');
        $engine = new Engine($model, 'postgres', 4);
        $ir = ['ir_version' => 1, 'manifest_hash' => $model->manifestHash, 'kind' => 'all', 'entity' => 'small_value',
            'where' => ['items' => [['pred' => ['column' => 'level', 'op' => 'between', 'ps' => [0, 1]]]]], 'n_params' => 2];
        self::assertTrue(str_contains($engine->compile($ir)['steps'][0]['sql'], '"a"."level" BETWEEN $1 AND $2'), 'i16 condition');
    }

    public function test_a_column_whose_condition_method_is_a_model_method_is_refused(): void
    {
        // jsonText is a public static method of Model. A column json_text would generate an instance method of that
        // name, which PHP refuses when the model class loads, so generation refuses the column instead.
        $doc = "dbspec 1 small\n\ntable small_value {\n  seq i64 identity\n  json_text i32\n  primary key (seq)\n}\n";
        $model = RuntimeModel::build(RuntimeModel::parse(['small.dbs' => $doc]));
        $out = sys_get_temp_dir() . '/orm-php-runtime-json-text-' . getmypid();
        $message = '';
        try {
            Generator::generate($model, $out, 'Polyspec\\Orm\\Tests\\Small');
        } catch (OrmException $e) {
            $message = $e->getMessage();
        }
        if (is_dir($out)) {
            array_map('unlink', glob("$out/*.php") ?: []);
            rmdir($out);
        }
        self::assertTrue(str_contains($message, 'the condition method jsonText is also the model method jsonText'), "refused: $message");
    }

    public function test_insert_binds_the_clock_of_an_omitted_default_now_column_except_on_MySQL(): void
    {
        $doc = "dbspec 1 clocked\n\ntable note {\n  id i64 identity\n  rank i16\n  body text\n  created_at datetime(6) default now\n  primary key (id)\n}\n";
        $model = RuntimeModel::build(RuntimeModel::parse(['clocked.dbs' => $doc]));
        self::assertTrue($model->entities['note']['columns']['created_at']['default_now'] && !$model->entities['note']['columns']['rank']['default_now'], 'default_now flag');
        $set = [['column' => 'rank', 'p' => 0], ['column' => 'body', 'p' => 1]];
        $single = ['ir_version' => 1, 'manifest_hash' => $model->manifestHash, 'kind' => 'insert', 'entity' => 'note', 'set' => $set, 'n_params' => 4];
        $multi = $single + ['rows' => [[2, 3]]];
        $q = ['mysql' => '`', 'postgres' => '"', 'sqlite' => '"'];
        foreach ($q as $dialect => $quote) {
            $engine = new Engine($model, $dialect, 4);
            foreach (['single' => [$single, 1], 'multi' => [$multi, 2]] as $kind => [$ir, $rows]) {
                $step = $engine->compile($ir)['steps'][0];
                $now = array_values(array_filter($step['bind_slots'], static fn(array $b): bool => $b['from'] === 'now'));
                if ($dialect !== 'mysql') {
                    self::assertTrue(str_contains($step['sql'], '("rank", "body", "created_at")') && count($now) === $rows && count($step['bind_slots']) === 3 * $rows, "$dialect $kind insert binds created_at: {$step['sql']}");
                } else {
                    self::assertTrue(!str_contains($step['sql'], 'created_at') && $now === [] && count($step['bind_slots']) === 2 * $rows, "$dialect $kind insert leaves created_at to the database: {$step['sql']}");
                }
            }
            $assigned = $single;
            $assigned['set'][] = ['column' => 'created_at', 'p' => 2];
            $assigned['n_params'] = 3;
            $step = $engine->compile($assigned)['steps'][0];
            self::assertTrue(array_filter($step['bind_slots'], static fn(array $b): bool => $b['from'] === 'now') === [], "$dialect an assigned created_at binds no clock: {$step['sql']}");
        }
    }

    public function test_configuration_without_a_schema_path(): void
    {
        $config = new Config(aesKey: 'k');
        self::assertTrue($config->aesKey === 'k', 'config');
        self::assertTrue(!property_exists($config, 'schemaPath'), 'schemaPath property');
        self::assertTrue(self::errorCode(fn() => new Config(aesVersion: 0)) === Code::CONFIG, 'invalid config');
    }

    public function test_requests_carry_the_manifest_hash(): void
    {
        $bench = self::bench();
        $engine = new Engine($bench, 'sqlite', 4);
        $ir = ['ir_version' => 1, 'manifest_hash' => 'sha256:00', 'kind' => 'all', 'entity' => 'service', 'n_params' => 0];
        self::assertTrue(self::errorCode(fn() => $engine->compile($ir)) === Code::SCHEMA_HASH_MISMATCH, 'other manifest hash');
        $ir['manifest_hash'] = $bench->manifestHash;
        self::assertTrue($engine->compile($ir)['manifest_hash'] === $bench->manifestHash, 'plan manifest hash');
    }
}
