<?php
// Codec cross-check (PHP side): every vector of tests/codec/vectors.json decodes with the PHP codec to its value, and
// every encoding produced by the other runners (tests/codec/out/<lang>.json, written by make codec-check into
// ORM_CODEC_OUT) decodes to the same value. Each data set is a vector name.
// Usage: make codec-check (the outputs of the other languages), or
//   vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/CodecVectorsTest.php
declare(strict_types=1);

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Codec;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\StyledValue;

#[Small]
final class CodecVectorsTest extends TestCase
{
    /** Value model: an ordered-json value is decoded; sequential arrays are lists, other arrays are maps with sorted string keys. */
    private static function canon(mixed $v): mixed
    {
        if ($v instanceof \Polyspec\OrderedJson\Value) {
            $v = json_decode(\Polyspec\OrderedJson\stringify($v), true, 512, JSON_THROW_ON_ERROR);
        }
        if (!is_array($v)) {
            return $v;
        }
        if (array_is_list($v)) {
            return array_map(self::canon(...), $v);
        }
        $out = [];
        foreach ($v as $k => $x) {
            $out[(string) $k] = self::canon($x);
        }
        ksort($out, SORT_STRING);
        return (object) $out;
    }

    private static function canonText(mixed $v): string
    {
        return json_encode(self::canon($v), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
    }

    /** vector의 style 이름 json은 dbspec codec stage ordered_json이다. */
    private static function styles(array $v): array
    {
        return array_map(static fn(string $s): string => $s === 'json' ? 'ordered_json' : $s, $v['styles']);
    }

    /** @return iterable<string, array{array<string, mixed>}> tests/codec/vectors.json의 vector마다 */
    public static function vectors(): iterable
    {
        $vectors = json_decode(file_get_contents(dirname(__DIR__, 3) . '/tests/codec/vectors.json'), true, 512, JSON_THROW_ON_ERROR)['vectors'];
        foreach ($vectors as $v) {
            yield $v['name'] => [$v];
        }
    }

    // memory 안에서 vector를 decode하고 encode한다.
    /** @param array<string, mixed> $v */
    #[DataProvider('vectors')]
    public function test_php_vector(array $v): void
    {
        $styles = self::styles($v);
        $raw = $v['encoded_b64'] === null ? null : base64_decode($v['encoded_b64'], true);
        $decoded = Codec::decode($styles, $raw);
        self::assertSame(self::canonText($v['value']), self::canonText($decoded->kind === 'sql-null' ? null : $decoded->payload()), 'php decode');
        $enc = Codec::encode($styles, $v['encoded_b64'] === null ? StyledValue::sqlNull() : StyledValue::value($v['value']));
        if ($v['deterministic']) {
            self::assertSame($v['encoded_b64'], $enc === null ? null : base64_encode($enc), 'php encode differs');
        }
    }

    // The value comparison above encodes both sides as JSON, which writes the float 777.0 as 777, so the
    // core int of yaml_core/leading_zero_int (YAML 1.2.2, 10.3.2: [-+]?[0-9]+) is also compared by its PHP type.
    public function test_yaml_core_leading_zero_int_is_an_int(): void
    {
        self::assertSame(777, Codec::decode(['yaml'], '0777')->payload());
    }

    /** @return iterable<string, array{Closure, string}> */
    public static function errors(): iterable
    {
        yield 'duplicate YAML key' => [fn() => Codec::decode(['yaml'], "a: 1\na: 2\n"), Code::CODEC_DECODE];
        yield 'multiple YAML documents' => [fn() => Codec::decode(['yaml'], "---\na: 1\n---\na: 2\n"), Code::CODEC_DECODE];
        yield 'YAML alias' => [fn() => Codec::decode(['yaml'], "a: &x [1]\nb: *x\n"), Code::CODEC_DECODE];
        yield 'YAML custom tag' => [fn() => Codec::decode(['yaml'], "a: !custom value\n"), Code::CODEC_DECODE];
        yield 'YAML anchor' => [fn() => Codec::decode(['yaml'], "a: &x 1\n"), Code::CODEC_DECODE];
        yield 'YAML standard tag' => [fn() => Codec::decode(['yaml'], "a: !!str 1\n"), Code::CODEC_DECODE];
        yield 'YAML merge key' => [fn() => Codec::decode(['yaml'], "a: {b: 1}\nc:\n  <<: {b: 1}\n"), Code::CODEC_DECODE];
        yield 'YAML null map key' => [fn() => Codec::decode(['yaml'], "~: value\n"), Code::CODEC_DECODE];
        yield 'YAML float map key' => [fn() => Codec::decode(['yaml'], "1.5: value\n"), Code::CODEC_DECODE];
        yield 'YAML collection map key' => [fn() => Codec::decode(['yaml'], "[a]: value\n"), Code::CODEC_DECODE];
        yield 'YAML non-finite number' => [fn() => Codec::decode(['yaml'], "value: .inf\n"), Code::CODEC_DECODE];
        yield 'YAML boolean map key' => [fn() => Codec::decode(['yaml'], "true: value\n"), Code::CODEC_DECODE];
        yield 'invalid YAML order' => [fn() => Codec::encode(['serialize', 'yaml'], StyledValue::value([])), Code::CODEC_UNSUPPORTED];
    }

    #[DataProvider('errors')]
    public function test_php_error(Closure $operation, string $code): void
    {
        try {
            $operation();
        } catch (OrmException $e) {
            self::assertSame($code, $e->code_);
            return;
        }
        self::fail("expected $code");
    }

    public function test_php_yaml_integer_map_key(): void
    {
        self::assertSame('{"1":"value"}', self::canonText(Codec::decode(['yaml'], "1: value\n")->payload()), 'YAML integer map key: expected string key');
    }

    /**
     * Go(TestCodecVectors), Rust(codec test), TypeScript(codec-vector.mjs)의 출력은 make codec-check가 이 실행에서
     * 그 test를 실행해 ORM_CODEC_OUT directory에 쓴 것만 읽는다. 다른 target이나 앞선 실행이 쓴 출력을 읽으면 이
     * 실행의 code를 비교하지 않는다. 없는 출력을 건너뛰면 비교하지 않은 언어가 통과로 보인다.
     */
    private static function assertOutput(string $lang, array $v): void
    {
        $out = (string) getenv('ORM_CODEC_OUT');
        self::assertNotSame('', $out, 'ORM_CODEC_OUT is unset; run make codec-check, which runs the Go, Rust and TypeScript codec tests into its run directory');
        $file = "$out/$lang.json";
        self::assertFileExists($file, "the $lang codec test of this run did not write it");
        $outs = json_decode(file_get_contents($file), true, 512, JSON_THROW_ON_ERROR);
        self::assertArrayHasKey($v['name'], $outs, "$lang: missing {$v['name']}");
        $raw = $outs[$v['name']] === null ? null : base64_decode($outs[$v['name']], true);
        $decoded = Codec::decode(self::styles($v), $raw);
        self::assertSame(self::canonText($v['value']), self::canonText($decoded->kind === 'sql-null' ? null : $decoded->payload()), "$lang → php");
    }

    /** @param array<string, mixed> $v */
    #[DataProvider('vectors')]
    public function test_go_output(array $v): void
    {
        self::assertOutput('go', $v);
    }

    /** @param array<string, mixed> $v */
    #[DataProvider('vectors')]
    public function test_rust_output(array $v): void
    {
        self::assertOutput('rust', $v);
    }

    /** @param array<string, mixed> $v */
    #[DataProvider('vectors')]
    public function test_typescript_output(array $v): void
    {
        self::assertOutput('typescript', $v);
    }
}
