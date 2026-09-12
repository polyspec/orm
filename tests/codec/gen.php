<?php
// Generates tests/codec/vectors.json — the PHP ground truth for every executor codec (docs/codec.md).
// Usage: php tests/codec/gen.php > tests/codec/vectors.json
declare(strict_types=1);

require dirname(__DIR__, 2) . '/clients/php/vendor/autoload.php';

use Symfony\Component\Yaml\Yaml;

// Map keys are sorted so Go/Rust (sorted-key encoders) produce the same serialize bytes.
$values = [
    'null' => null,
    'bool_true' => true,
    'int' => 42,
    'negative_int' => -7,
    'float' => 1.5,
    'float_small' => 0.1,
    'integral_float' => 2.0,
    'string' => 'hello',
    'unicode_slash' => '한글/slash "q" \\ back',
    'empty_string' => '',
    'empty_list' => [],
    'list' => [1, 'two', 3.5, null, false],
    'nested_map' => ['a' => 1, 'b' => [1, 2, ['c' => '한']], 'd' => null, 'e' => true, 'f' => 1.5],
    'int_keys_sparse' => [1 => 'x', 5 => 'y'],
    'numeric_string_keys' => ['-3' => 'neg', '07' => 'zero-padded', '10' => 'ten'],
    'upload_nested' => ['files' => [
        ['$type' => 'upload_file', 'mime' => 'text/plain', 'name' => 'report.txt', 'path' => '/tmp/report.txt'],
        ['$type' => 'upload_file', 'mime' => '', 'name' => 'raw.bin', 'path' => '/tmp/raw.bin'],
    ], 'title' => 'request'],
];

$styles = [
    'json' => ['json'],
    'serialize' => ['serialize'],
    'base64' => ['serialize', 'base64'],
    'gz' => ['serialize', 'gz'],
    'curlfile' => ['curlfile', 'serialize'],
    'yaml' => ['yaml'],
];

function prepare_curlfiles(mixed $value): mixed
{
    if (!is_array($value)) {
        return $value;
    }
    if (($value['$type'] ?? null) === 'upload_file') {
        return ['is_curl_file' => true, 'mime' => $value['mime'], 'name' => $value['name'], 'path' => $value['path']];
    }
    foreach ($value as $key => $item) {
        $value[$key] = prepare_curlfiles($item);
    }
    return $value;
}

function encode(array $styles, mixed $v): ?string
{
    if ($v === null) {
        return null;
    }
    $cur = null;
    $value = $v;
    foreach ($styles as $st) {
        $cur = match ($st) {
            'curlfile' => $value = prepare_curlfiles($value),
            'serialize' => serialize($value),
            'yaml' => Yaml::dump($value, 20, 2, Yaml::DUMP_EXCEPTION_ON_INVALID_TYPE | Yaml::DUMP_EMPTY_ARRAY_AS_SEQUENCE | Yaml::DUMP_NUMERIC_KEY_AS_STRING),
            'json', 'jsons' => json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR),
            'base64' => base64_encode($cur),
            'gz' => gzcompress($cur, 9),
        };
    }
    return $cur;
}

$out = [];
foreach ($styles as $name => $chain) {
    foreach ($values as $vname => $v) {
        $enc = encode($chain, $v);
        $out[] = [
            'name' => "$name/$vname",
            'styles' => $chain,
            'value' => $v,
            // maps with only int keys are still maps in the value model (keys become strings) unless sequential
            'encoded_b64' => $enc === null ? null : base64_encode($enc),
            // gz bytes depend on the zlib implementation; json key order differs; JSON cannot say 2.0 vs 2
            'deterministic' => !in_array('gz', $chain, true) && $name !== 'json' && $name !== 'yaml' && !(is_float($v) && floor($v) === $v),
        ];
    }
}
echo json_encode(['vectors' => $out], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), "\n";
