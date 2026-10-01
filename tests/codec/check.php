<?php
// Codec cross-check (PHP side): every vector decodes with the PHP codec to its value, and every
// encoding produced by the other runners (tests/codec/out/<lang>.json) decodes to the same value.
// Usage: php tests/codec/check.php
declare(strict_types=1);

require dirname(__DIR__, 2) . '/clients/php/tests/autoload.php';

use Orm\Codec;
use Orm\Code;
use Orm\OrmException;
use Orm\StyledValue;

$root = __DIR__;
$vectors = json_decode(file_get_contents("$root/vectors.json"), true, 512, JSON_THROW_ON_ERROR)['vectors'];
$fail = 0;
$canon = fn(mixed $v): string => json_encode(canon($v), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);

/** Value model: an ordered-json value is decoded; sequential arrays are lists, other arrays are maps with sorted string keys. */
function canon(mixed $v): mixed
{
    if ($v instanceof \OrderedJson\Value) {
        $v = json_decode(\OrderedJson\stringify($v), true, 512, JSON_THROW_ON_ERROR);
    }
    if (!is_array($v)) {
        return $v;
    }
    if (array_is_list($v)) {
        return array_map('canon', $v);
    }
    $out = [];
    foreach ($v as $k => $x) {
        $out[(string) $k] = canon($x);
    }
    ksort($out, SORT_STRING);
    return (object) $out;
}

foreach ($vectors as $v) {
    // vector의 style 이름 json은 dbspec codec stage ordered_json이다.
    $styles = array_map(static fn(string $s): string => $s === 'json' ? 'ordered_json' : $s, $v['styles']);
    $want = $canon($v['value']);
    $raw = $v['encoded_b64'] === null ? null : base64_decode($v['encoded_b64'], true);
    $decoded = Codec::decode($styles, $raw);
    $got = $canon($decoded->kind === 'sql-null' ? null : $decoded->payload());
    if ($got !== $want) {
        $fail++;
        fwrite(STDERR, "php decode {$v['name']}: $got want $want\n");
    }
    $enc = Codec::encode($styles, $v['encoded_b64'] === null ? StyledValue::sqlNull() : StyledValue::value($v['value']));
    if ($v['deterministic'] && ($enc === null ? null : base64_encode($enc)) !== $v['encoded_b64']) {
        $fail++;
        fwrite(STDERR, "php encode {$v['name']} differs\n");
    }
}
$errors = [
    ['duplicate YAML key', fn() => Codec::decode(['yaml'], "a: 1\na: 2\n"), Code::CODEC_DECODE],
    ['multiple YAML documents', fn() => Codec::decode(['yaml'], "---\na: 1\n---\na: 2\n"), Code::CODEC_DECODE],
    ['YAML alias', fn() => Codec::decode(['yaml'], "a: &x [1]\nb: *x\n"), Code::CODEC_DECODE],
    ['YAML custom tag', fn() => Codec::decode(['yaml'], "a: !custom value\n"), Code::CODEC_DECODE],
    ['YAML non-finite number', fn() => Codec::decode(['yaml'], "value: .inf\n"), Code::CODEC_DECODE],
    ['YAML boolean map key', fn() => Codec::decode(['yaml'], "true: value\n"), Code::CODEC_DECODE],
    ['invalid YAML order', fn() => Codec::encode(['serialize', 'yaml'], StyledValue::value([])), Code::CODEC_UNSUPPORTED],
];
foreach ($errors as [$name, $operation, $code]) {
    try {
        $operation();
        $fail++;
        fwrite(STDERR, "$name: expected $code\n");
    } catch (OrmException $e) {
        if ($e->code_ !== $code) {
            $fail++;
            fwrite(STDERR, "$name: {$e->code_} want $code\n");
        }
    }
}
if ($canon(Codec::decode(['yaml'], "1: value\n")->payload()) !== '{"1":"value"}') {
    $fail++;
    fwrite(STDERR, "YAML integer map key: expected string key\n");
}
$langs = 0;
foreach (glob("$root/out/*.json") as $file) {
    $lang = basename($file, '.json');
    $langs++;
    $outs = json_decode(file_get_contents($file), true, 512, JSON_THROW_ON_ERROR);
    foreach ($vectors as $v) {
        if (!array_key_exists($v['name'], $outs)) {
            $fail++;
            fwrite(STDERR, "$lang: missing {$v['name']}\n");
            continue;
        }
        $raw = $outs[$v['name']] === null ? null : base64_decode($outs[$v['name']], true);
        $decoded = Codec::decode(array_map(static fn(string $s): string => $s === 'json' ? 'ordered_json' : $s, $v['styles']), $raw);
        $got = $canon($decoded->kind === 'sql-null' ? null : $decoded->payload());
        if ($got !== $canon($v['value'])) {
            $fail++;
            fwrite(STDERR, "$lang → php {$v['name']}: $got want " . $canon($v['value']) . "\n");
        }
    }
}
if ($fail === 0) {
    echo 'codec: ' . count($vectors) . " vectors ok in PHP; $langs other-language outputs decode identically\n";
    exit(0);
}
fwrite(STDERR, "codec: $fail failures\n");
exit(1);
