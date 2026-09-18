<?php
// Engine test: manifest hash check, request validation, statement forms of each
// dialect, and generator output.
// Usage: php clients/php/tests/engine_test.php
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use Orm\Code;
use Orm\Engine;
use Orm\Generator;
use Orm\Manifest;
use Orm\OrmException;

$root = dirname(__DIR__, 3);
$json = (string) file_get_contents("$root/schema/schema.json");
$manifest = Manifest::load($json);
$failures = 0;

function expect(bool $ok, string $message): void
{
    global $failures;
    if (!$ok) {
        $failures++;
        fwrite(STDERR, "FAIL $message\n");
    }
}

function code(callable $fn): string
{
    try {
        $fn();
    } catch (OrmException $e) {
        return $e->code_;
    }
    return 'no error';
}

expect(code(fn() => Manifest::load(str_replace('"table": "battle"', '"table": "battles"', $json))) === Code::SCHEMA_INVALID, 'edited manifest');

$engines = [];
foreach (['mysql', 'postgres', 'sqlite'] as $d) {
    $engines[$d] = new Engine($manifest, $d, 8);
}
$request = static fn(array $ir): array => ['ir_version' => 1, 'schema_hash' => $manifest->schemaHash] + $ir;
$byId = $request(['kind' => 'one', 'entity' => 'service', 'where' => ['items' => [['pred' => ['column' => 'seq', 'op' => 'eq', 'p' => 0]]]], 'n_params' => 1]);

$want = [
    'mysql' => 'SELECT `a`.`seq` AS `a__seq`, `a`.`name` AS `a__name` FROM `service` AS `a` WHERE `a`.`seq` = ? LIMIT 0, 1',
    'postgres' => 'SELECT "a"."seq" AS "a__seq", "a"."name" AS "a__name" FROM "service" AS "a" WHERE "a"."seq" = $1 LIMIT 1 OFFSET 0',
    'sqlite' => 'SELECT "a"."seq" AS "a__seq", "a"."name" AS "a__name" FROM "service" AS "a" WHERE "a"."seq" = ? LIMIT 1 OFFSET 0',
];
foreach ($engines as $d => $engine) {
    $plan = $engine->plan($byId);
    expect($plan['steps'][0]['sql'] === $want[$d], "$d primary-key select: {$plan['steps'][0]['sql']}");
    expect($engine->plan($byId) === $plan, "$d plan cache");
}

$mysql = $engines['mysql'];
foreach ([
    'unknown field' => [$request(['kind' => 'all', 'entity' => 'service', 'keyset' => ['direction' => 'after'], 'n_params' => 0]), Code::IR_INVALID],
    'raw kind' => [$request(['kind' => 'raw', 'entity' => 'service', 'n_params' => 0]), Code::IR_INVALID],
    'max kind' => [$request(['kind' => 'max', 'entity' => 'service', 'agg' => 'seq', 'n_params' => 0]), Code::IR_INVALID],
    'wrong type' => [$request(['kind' => 'all', 'entity' => 'service', 'n_params' => '0']), Code::IR_INVALID],
    'schema hash' => [['ir_version' => 1, 'schema_hash' => 'x', 'kind' => 'all', 'entity' => 'service', 'n_params' => 0], Code::SCHEMA_HASH_MISMATCH],
    'entity' => [$request(['kind' => 'all', 'entity' => 'missing', 'n_params' => 0]), Code::ENTITY_UNKNOWN],
    'param range' => [$request(['kind' => 'all', 'entity' => 'service', 'where' => ['items' => [['pred' => ['column' => 'seq', 'op' => 'eq', 'p' => 1]]]], 'n_params' => 1]), Code::IR_INVALID],
    'or first' => [$request(['kind' => 'all', 'entity' => 'service', 'where' => ['items' => [['pred' => ['conn' => 'or', 'column' => 'seq', 'op' => 'eq', 'p' => 0]]]], 'n_params' => 1]), Code::OR_AT_GROUP_START],
    'like op' => [$request(['kind' => 'all', 'entity' => 'service', 'where' => ['items' => [['pred' => ['column' => 'name', 'op' => 'like', 'p' => 0]]]], 'n_params' => 1]), Code::OPERATOR_NOT_ALLOWED],
    'empty in' => [$request(['kind' => 'all', 'entity' => 'service', 'where' => ['items' => [['pred' => ['column' => 'seq', 'op' => 'in', 'ps' => []]]]], 'n_params' => 0]), Code::EMPTY_IN],
    'update without where' => [$request(['kind' => 'update', 'entity' => 'service', 'set' => [['column' => 'name', 'p' => 0]], 'n_params' => 1]), Code::IR_INVALID],
] as $name => [$ir, $code]) {
    expect(code(fn() => $mysql->compile($ir)) === $code, "validation: $name");
}

$fulltext = $request(['kind' => 'all', 'entity' => 'battle', 'where' => ['items' => [['pred' => ['op' => 'match', 'match' => $manifest->entities['battle']['fulltext'][0], 'p' => 0]]]], 'n_params' => 1]);
expect(code(fn() => $engines['sqlite']->compile($fulltext)) === Code::OPERATOR_NOT_ALLOWED, 'sqlite full-text');
expect(str_contains($engines['postgres']->compile($fulltext)['steps'][0]['sql'], "plainto_tsquery('simple', \$1)"), 'postgres full-text');

$out = sys_get_temp_dir() . '/orm-php-gen-' . getmypid();
Generator::generate($manifest, $out, 'App\Orm');
foreach (glob("$root/clients/php/gen/*.php") as $file) {
    expect(file_get_contents($file) === file_get_contents($out . '/' . basename($file)), 'generated ' . basename($file));
}
array_map('unlink', glob("$out/*.php"));
rmdir($out);

if ($failures > 0) {
    fwrite(STDERR, "php engine test: $failures failures\n");
    exit(1);
}
echo "php engine test: passed\n";
