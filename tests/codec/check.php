<?php
// Codec cross-check (PHP side): every vector decodes with the PHP codec to its value, and every
// encoding produced by the other runners (tests/codec/out/<lang>.json) decodes to the same value.
// Usage: php tests/codec/check.php
declare(strict_types=1);

require dirname(__DIR__, 2) . '/clients/php/tests/autoload.php';

use Orm\Codec;
use Orm\Code;
use Orm\OrmException;

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
    $want = $canon($v['value']);
    $raw = $v['encoded_b64'] === null ? null : base64_decode($v['encoded_b64'], true);
    $got = $canon(Codec::decode($v['styles'], $raw));
    if ($got !== $want) {
        $fail++;
        fwrite(STDERR, "php decode {$v['name']}: $got want $want\n");
    }
    $enc = Codec::encode($v['styles'], $v['value']);
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
    ['invalid YAML order', fn() => Codec::encode(['serialize', 'yaml'], []), Code::CODEC_UNSUPPORTED],
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
if ($canon(Codec::decode(['yaml'], "1: value\n")) !== '{"1":"value"}') {
    $fail++;
    fwrite(STDERR, "YAML integer map key: expected string key\n");
}
if ($canon(Codec::point('POINT(1.25 -2)')) !== '[1.25,-2]' || $canon(Codec::point('(1.25,-2)')) !== '[1.25,-2]' || Codec::pointText([1.25, -2]) !== 'POINT(1.25 -2)') {
    $fail++;
    fwrite(STDERR, "point conversion failed\n");
}
if (Codec::pointText([-0.0, 0.0]) !== 'POINT(0 0)') { $fail++; fwrite(STDERR, "point negative zero normalization failed\n"); }
foreach ([
    ['invalid point text', fn() => Codec::point('POINT(1)'), Code::CODEC_DECODE],
    ['non-finite point', fn() => Codec::pointText([1.0, NAN]), Code::CODEC_ENCODE],
] as [$name, $operation, $code]) {
    try { $operation(); $fail++; fwrite(STDERR, "$name: expected $code\n"); }
    catch (OrmException $e) { if ($e->code_ !== $code) { $fail++; fwrite(STDERR, "$name: {$e->code_} want $code\n"); } }
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
        $got = $canon(Codec::decode($v['styles'], $raw));
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
