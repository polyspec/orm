<?php
// Generates tests/codec/vectors.json — the PHP ground truth for every executor codec (docs/spec/codec.md).
// Usage: php tests/codec/gen.php > tests/codec/vectors.json
declare(strict_types=1);

require dirname(__DIR__, 2) . '/vendor-php/autoload.php';

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
    'yaml' => ['yaml'],
];
// A list that starts with base64 or gz serializes nothing: the stage takes a string value and stores its UTF-8 text
// (docs/spec/codec.md, Stage lists). Any other value is CODEC_ENCODE, and SQL NULL stays SQL NULL.
$textStyles = [
    'base64_text' => ['base64'],
    'gz_text' => ['gz'],
];

function encode(array $styles, mixed $v): ?string
{
    if ($v === null) {
        return null;
    }
    $cur = null;
    $value = $v;
    foreach ($styles as $st) {
        $cur = match ($st) {
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
            'name' => "$name.$vname",
            'styles' => $chain,
            'value' => $v,
            // maps with only int keys are still maps in the value model (keys become strings) unless sequential
            'encoded_b64' => $enc === null ? null : base64_encode($enc),
            // gz bytes depend on the zlib implementation; json key order differs; JSON cannot say 2.0 vs 2
            'deterministic' => !in_array('gz', $chain, true) && $name !== 'json' && $name !== 'yaml' && !(is_float($v) && floor($v) === $v),
        ];
    }
}
foreach ($textStyles as $name => $chain) {
    foreach ($values as $vname => $v) {
        if ($v !== null && !is_string($v)) {
            $out[] = ['name' => "$name.$vname", 'styles' => $chain, 'value' => $v, 'encode_error' => 'CODEC_ENCODE'];
            continue;
        }
        $enc = $v === null ? null : ($chain === ['gz'] ? gzcompress($v, 9) : base64_encode($v));
        $out[] = [
            'name' => "$name.$vname",
            'styles' => $chain,
            'value' => $v,
            'encoded_b64' => $enc === null ? null : base64_encode($enc),
            'deterministic' => $chain !== ['gz'],
        ];
    }
}
// The ip host stage packs only the exact text of an address: white space around or inside it is CODEC_ENCODE, so two
// inputs never store the same bytes and the stored value reads back as the input (docs/spec/codec.md, Decoding is exact).
$ipWhiteSpace = [
    'leading_space' => ' 192.0.2.1',
    'trailing_space' => '192.0.2.1 ',
    'trailing_newline' => "192.0.2.1\n",
    'leading_tab' => "\t192.0.2.1",
    'inner_space' => '192.0. 2.1',
    'v6_leading_space' => ' 2001:db8::1',
    'v6_trailing_newline' => "2001:db8::1\n",
    'v6_inner_space' => '2001:db8:: 1',
    'leading_nul' => "\x00192.0.2.1",
    'inner_nul' => "192.0.2\x00.1",
    'leading_form_feed' => "\f192.0.2.1",
    'trailing_no_break_space' => "192.0.2.1\u{a0}",
];
foreach ($ipWhiteSpace as $vname => $v) {
    $out[] = ['name' => "ip.$vname", 'styles' => ['ip'], 'value' => $v, 'encode_error' => 'CODEC_ENCODE'];
}
// Plain scalars read by the YAML 1.2 core schema (YAML 1.2.2, 10.3.2): stored text and value.
// The text is given, not dumped, since an encoder quotes these strings.
$yamlCore = [
    'binary_like' => ["0b101", '0b101'],
    'signed_hex_like' => ["+0x1", '+0x1'],
    'underscore_int_like' => ["1_000", '1_000'],
    'date_like' => ["2014-12-31", '2014-12-31'],
    'timestamp_like' => ["2001-12-14t21:59:43.10-05:00", '2001-12-14t21:59:43.10-05:00'],
    'next_line' => ["a\u{85}b", "a\u{85}b"],
    'leading_zero_int' => ["0777", 777],
    'octal' => ["0o17", 15],
    'hex' => ["0x1F", 31],
    'signed_int' => ["+12", 12],
    'map' => ["a: 1_000\nb: 0b101\nc: 2014-12-31\n", ['a' => '1_000', 'b' => '0b101', 'c' => '2014-12-31']],
];
foreach ($yamlCore as $vname => [$text, $v]) {
    $out[] = [
        'name' => "yaml_core.$vname",
        'styles' => ['yaml'],
        'value' => $v,
        'encoded_b64' => base64_encode($text),
        'deterministic' => false,
    ];
}
// The requirements of docs/spec/codec.md that the vectors test (config/parity.json, unit codec).
$requirements = ['COD-3', 'COD-9', 'COD-10', 'COD-11', 'COD-12', 'COD-13', 'COD-14', 'COD-16', 'COD-28', 'COD-29', 'COD-30', 'COD-33', 'COD-36', 'COD-38', 'COD-40'];
echo json_encode(['requirements' => $requirements, 'vectors' => $out], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), "\n";
