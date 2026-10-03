<?php
declare(strict_types=1);
// The runtime model of schema/bench.dbs (docs/dbspec.md "Runtime model"):
// entities, the default select set, codec value types, the generated models
// and their manifest hash, i16 fields, and a connection configuration without
// a schema path. Database behavior is in runtime_db_test.php.
// Usage: php clients/php/tests/runtime_model_test.php
require __DIR__ . '/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';

use Polyspec\Orm\Tests\Model\Author;
use Orm\Code;
use Orm\Config;
use Orm\Dbspec\Dbspec;
use Orm\Engine;
use Orm\Generator;
use Orm\OrmException;
use Orm\Registry;
use Orm\RuntimeModel;

$root = dirname(__DIR__, 3);
$failures = 0;

/** 한 case를 memory 안의 계산 기한(TESTCASE_COMPUTE) 아래에서 실행하고 보고한다. */
function runCase(string $name, Closure $fn): void
{
    global $failures;
    if (!testcase_run("runtime_model/$name", TESTCASE_COMPUTE, static fn() => $fn())) {
        $failures++;
    }
}

function want(bool $ok, string $message): void
{
    if (!$ok) {
        throw new RuntimeException($message);
    }
}

function errorCode(Closure $fn): string
{
    try {
        $fn();
    } catch (OrmException $e) {
        return $e->code_;
    }
    return 'no error';
}

$bench = RuntimeModel::build(RuntimeModel::files(["$root/schema/bench.dbs"]));

runCase('entities in document order', function () use ($bench): void {
    $want = ['author', 'user', 'service', 'service_region', 'service_member', 'composite_account', 'composite_membership', 'soft_record', 'account', 'project', 'account_project', 'task'];
    want(array_keys($bench->entities) === $want, 'entities ' . implode(',', array_keys($bench->entities)));
    $author = $bench->entities['author'];
    want($author['identity'] === 'seq' && $author['pk'] === ['seq'], 'author keys');
    want($author['updated'] === 'updated_ts' && $author['aes_version'] === 'aes_key_version', 'author settings');
    want($bench->entities['soft_record']['soft_delete'] === 'deleted_at', 'soft delete setting');
    want($author['columns']['aes_hex_email']['blind_index'] === 'email_blind_index', 'blind index setting');
    want($author['columns']['json_setting']['codec'] === ['ordered_json'], 'ordered_json codec');
});

runCase('default select set excludes only select explicit', function () use ($bench): void {
    $selected = [];
    foreach ($bench->entities['author']['columns'] as $name => $c) {
        if ($c['select']) {
            $selected[] = $name;
        }
    }
    $explicit = ['description', 'email_blind_index', 'phone_blind_index', 'ip', 'gz_extend', 'json_setting', 'jsons_tags', 'base64_extra', 'serialize_data', 'aes_key_version'];
    $want = array_values(array_diff(array_keys($bench->entities['author']['columns']), $explicit));
    want($selected === $want, 'selected ' . implode(',', $selected));
});

runCase('generated models carry the manifest hash and the model', function () use ($root, $bench): void {
    $manifest = Dbspec::manifest(RuntimeModel::files(["$root/schema/bench.dbs"]))->manifest;
    $hash = Author::meta()['manifest_hash'];
    want($hash === $manifest->manifestHash, "manifest hash $hash");
    want(str_starts_with($hash, 'sha256:'), 'manifest hash form');
    want(Registry::manifestText($hash) === $manifest->manifestText, 'manifest text');
    want(Registry::model($hash)->entities === $bench->entities, 'generated model differs from the document model');
});

runCase('generated files are current', function () use ($root, $bench): void {
    $lines = Generator::check($bench, "$root/clients/php/gen", 'Polyspec\\Orm\\Tests\\Model');
    want($lines === [], implode("\n", $lines));
});

runCase('codec value types', function (): void {
    $type = static fn(string $method): string => (string) (new ReflectionMethod(Author::class, $method))->getReturnType();
    foreach (['getJsonSetting', 'getJsonsTags', 'getSerializeData', 'getGzExtend', 'getBase64Extra'] as $m) {
        want($type($m) === 'Orm\\StyledValue', "$m returns " . $type($m));
    }
    foreach (['getAesHexEmail', 'getIp', 'getPrice', 'getDescription'] as $m) {
        want($type($m) === '?string', "$m returns " . $type($m));
    }
    want($type('getTargetClubReaderCount') === 'int' && $type('getIsClose') === 'bool', 'scalar types');
    want($type('getCreatedTs') === 'DateTimeImmutable', 'datetime type');
});

runCase('i16 field', function () use ($root): void {
    $doc = "dbspec 1 small\n\ntable small_value {\n  seq i64 identity\n  level i16\n  rank i16 null\n  primary key (seq)\n}\n";
    $model = RuntimeModel::build(RuntimeModel::parse(['small.dbs' => $doc]));
    want($model->entities['small_value']['columns']['level']['type'] === 'i16', 'i16 type');
    $out = sys_get_temp_dir() . '/orm-php-runtime-i16-' . getmypid();
    Generator::generate($model, $out, 'Small\\Orm');
    $body = (string) file_get_contents("$out/SmallValue.php");
    array_map('unlink', glob("$out/*.php"));
    rmdir($out);
    want(str_contains($body, 'public function getLevel(): int') && str_contains($body, 'public function getRank(): ?int'), 'i16 accessors');
    $engine = new Engine($model, 'postgres', 4);
    $ir = ['ir_version' => 1, 'manifest_hash' => $model->manifestHash, 'kind' => 'all', 'entity' => 'small_value',
        'where' => ['items' => [['pred' => ['column' => 'level', 'op' => 'between', 'ps' => [0, 1]]]]], 'n_params' => 2];
    want(str_contains($engine->compile($ir)['steps'][0]['sql'], '"a"."level" BETWEEN $1 AND $2'), 'i16 condition');
});

runCase('insert binds the clock of an omitted default now column only on SQLite', function (): void {
    $doc = "dbspec 1 clocked\n\ntable note {\n  id i64 identity\n  rank i16\n  body text\n  created_at datetime(6) default now\n  primary key (id)\n}\n";
    $model = RuntimeModel::build(RuntimeModel::parse(['clocked.dbs' => $doc]));
    want($model->entities['note']['columns']['created_at']['default_now'] && !$model->entities['note']['columns']['rank']['default_now'], 'default_now flag');
    $set = [['column' => 'rank', 'p' => 0], ['column' => 'body', 'p' => 1]];
    $single = ['ir_version' => 1, 'manifest_hash' => $model->manifestHash, 'kind' => 'insert', 'entity' => 'note', 'set' => $set, 'n_params' => 4];
    $multi = $single + ['rows' => [[2, 3]]];
    $q = ['mysql' => '`', 'postgres' => '"', 'sqlite' => '"'];
    foreach ($q as $dialect => $quote) {
        $engine = new Engine($model, $dialect, 4);
        foreach (['single' => [$single, 1], 'multi' => [$multi, 2]] as $kind => [$ir, $rows]) {
            $step = $engine->compile($ir)['steps'][0];
            $now = array_values(array_filter($step['bind_slots'], static fn(array $b): bool => $b['from'] === 'now'));
            if ($dialect === 'sqlite') {
                want(str_contains($step['sql'], '("rank", "body", "created_at")') && count($now) === $rows && count($step['bind_slots']) === 3 * $rows, "$dialect $kind insert binds created_at: {$step['sql']}");
            } else {
                want(!str_contains($step['sql'], 'created_at') && $now === [] && count($step['bind_slots']) === 2 * $rows, "$dialect $kind insert leaves created_at to the database: {$step['sql']}");
            }
        }
        $assigned = $single;
        $assigned['set'][] = ['column' => 'created_at', 'p' => 2];
        $assigned['n_params'] = 3;
        $step = $engine->compile($assigned)['steps'][0];
        want(array_filter($step['bind_slots'], static fn(array $b): bool => $b['from'] === 'now') === [], "$dialect an assigned created_at binds no clock: {$step['sql']}");
    }
});

runCase('configuration without a schema path', function (): void {
    $config = new Config(aesKey: 'k');
    want($config->aesKey === 'k', 'config');
    want(!property_exists($config, 'schemaPath'), 'schemaPath property');
    want(errorCode(fn() => new Config(aesVersion: 0)) === Code::CONFIG, 'invalid config');
});

runCase('requests carry the manifest hash', function () use ($bench): void {
    $engine = new Engine($bench, 'sqlite', 4);
    $ir = ['ir_version' => 1, 'manifest_hash' => 'sha256:00', 'kind' => 'all', 'entity' => 'service', 'n_params' => 0];
    want(errorCode(fn() => $engine->compile($ir)) === Code::SCHEMA_HASH_MISMATCH, 'other manifest hash');
    $ir['manifest_hash'] = $bench->manifestHash;
    want($engine->compile($ir)['manifest_hash'] === $bench->manifestHash, 'plan manifest hash');
});

if ($failures > 0) {
    exit(1);
}
