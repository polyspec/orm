<?php

// The recipe helper of PHP (docs/spec/feature-coverage.md FCV-2 to FCV-4): the entry of each suite unit, a test class
// <Recipe>RecipeTest whose method test<Database> takes the cases of Recipe::cases, calls Recipe::run for each case, and
// each step calls the public API of Polyspec\Orm that its op names. The PHP extension runs the same entry through a
// class that extends it. It has no command line and no output of its own.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use Polyspec\OrderedJson\Kind;
use Polyspec\OrderedJson\Value as OrderedJson;
use Polyspec\Orm\Bytes;
use Polyspec\Orm\Codec;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\StyledValue;

final class Recipe
{
    /** The database part of a recipe without a database (FCV-3). */
    public const NONE = 'none';

    /** @return iterable<string, array{array<string, mixed>}> each case of the recipe at path, relative to the repository root */
    public static function cases(string $path): iterable
    {
        $recipe = json_decode(file_get_contents(dirname(__DIR__, 3) . '/' . $path), true, 512, JSON_THROW_ON_ERROR);
        foreach ($recipe['cases'] as $case) {
            yield $case['id'] => [$case];
        }
    }

    /** Runs the steps of one case on database. */
    public static function run(string $path, array $case, string $database): void
    {
        if ($database !== self::NONE) {
            Assert::fail("recipe $path: database $database has no case database in this helper");
        }
        $bound = [];
        foreach ($case['steps'] as $index => $step) {
            try {
                self::step($step, $bound, $database);
            } catch (\PHPUnit\Framework\AssertionFailedError $failure) {
                Assert::fail(
                    "recipe $path case {$case['id']} step $index ({$step['op']}) on $database: {$failure->getMessage()}"
                );
            }
        }
    }

    /** Maps the op of step to its call and checks the result against the expect of database. */
    private static function step(array $step, array &$bound, string $database): void
    {
        $result = ['decoded' => false, 'value' => null, 'error' => null];
        $styles = $step['styles'] ?? [];
        $key = $step['key'] ?? '';
        try {
            $result['value'] = match ($step['op']) {
                'codec.decode' => Codec::decode($styles, self::cell($step['raw'], $bound)),
                'codec.encode' => Codec::encode($styles, self::styledArgument($step['value'], $styles, $bound)),
                'codec.host_encode' => Codec::hostEncode(self::argument($step['value'], $bound), $styles, $key),
                'codec.host_decode' => Codec::hostDecode(self::cell($step['raw'], $bound), $styles, $key),
                'codec.blind_index' => Codec::blindIndex(self::argument($step['value'], $bound), $key),
                default => Assert::fail("OP_UNKNOWN {$step['op']}"),
            };
        } catch (OrmException $error) {
            $result['error'] = $error;
        }
        $result['decoded'] = $step['op'] === 'codec.decode';
        if (isset($step['as'])) {
            $bound[$step['as']] = $result;
        }
        $expect = $step['expect'][$database] ?? null;
        if ($expect === null) {
            if ($result['error'] !== null) {
                Assert::fail("unexpected error {$result['error']->getMessage()}");
            }
            return;
        }
        if (isset($expect['error'])) {
            $code = $result['error']?->code_ ?? 'none';
            if ($code !== $expect['error']) {
                Assert::fail("error $code, want {$expect['error']}");
            }
            return;
        }
        if ($result['error'] !== null) {
            Assert::fail("unexpected error {$result['error']->getMessage()}");
        }
        $want = $expect['value'];
        if (!$result['decoded']) {
            self::compareCell($want, $result['value']);
            return;
        }
        $styled = $result['value'];
        if ($styled->kind === 'sql-null') {
            if (!array_key_exists('null', $want)) {
                Assert::fail('SQL NULL, want ' . json_encode($want));
            }
            return;
        }
        $payload = $styled->payload();
        $ordered = in_array('ordered_json', $styles, true);
        if (!self::equal($payload, $want, $ordered)) {
            Assert::fail('decoded ' . self::shown($payload) . ', want ' . json_encode($want, JSON_UNESCAPED_UNICODE));
        }
    }

    /**
     * Compares the cell of an encode, a host decode or a blind index with a wrapper: bytes by bytes, a text cell by its
     * UTF-8 bytes (FCV-4), and SQL NULL with null.
     */
    private static function compareCell(array $want, mixed $cell): void
    {
        if ($cell === null) {
            if (!array_key_exists('null', $want)) {
                Assert::fail('no cell, want ' . json_encode($want));
            }
            return;
        }
        $got = $cell instanceof Bytes ? $cell->bytes : $cell;
        $expected = match (true) {
            array_key_exists('bytes_hex', $want) => hex2bin($want['bytes_hex']),
            array_key_exists('text', $want) => $want['text'],
            default => Assert::fail('a cell compares with bytes_hex or text, not ' . json_encode($want)),
        };
        if ($got !== $expected) {
            Assert::fail('cell ' . bin2hex($got) . ', want ' . bin2hex($expected));
        }
    }

    private static function reference(string $name, array $bound): mixed
    {
        if (!array_key_exists($name, $bound)) {
            Assert::fail("ref $name names no bound result");
        }
        if ($bound[$name]['error'] !== null) {
            Assert::fail("ref $name names a failed step: {$bound[$name]['error']->getMessage()}");
        }
        return $bound[$name]['value'];
    }

    /** A stored cell, which PHP holds as a string of bytes: SQL NULL is null, and bytes or a written cell are their string. */
    private static function cell(array $raw, array $bound): ?string
    {
        $value = self::argument($raw, $bound);
        return $value instanceof Bytes ? $value->bytes : $value;
    }

    /** The value of an argument: the result that a ref names, or the value of a wrapper. */
    private static function argument(array $raw, array $bound): mixed
    {
        if (array_key_exists('ref', $raw)) {
            return self::reference($raw['ref'], $bound);
        }
        return self::toValue($raw);
    }

    /**
     * The styled value an encode takes: SQL NULL for null, an ordered-json value for an ordered_json stage, so that its
     * member order and number text are those of the recipe, and the common value model otherwise.
     */
    private static function styledArgument(array $raw, array $styles, array $bound): StyledValue
    {
        if (array_key_exists('ref', $raw)) {
            $value = self::reference($raw['ref'], $bound);
            return $value instanceof StyledValue ? $value : StyledValue::value($value);
        }
        if (array_key_exists('null', $raw)) {
            return StyledValue::sqlNull();
        }
        if (in_array('ordered_json', $styles, true)) {
            return StyledValue::value(OrderedJson::parse(self::jsonText($raw)));
        }
        return StyledValue::value(self::toValue($raw));
    }

    /** A wrapper as JSON text with its members in order and its numbers as their recipe text. */
    private static function jsonText(array $w): string
    {
        $kind = array_key_first($w);
        $flags = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR;
        return match ($kind) {
            'nil' => 'null',
            'bool' => $w['bool'] ? 'true' : 'false',
            'int', 'float' => $w[$kind],
            'text' => json_encode($w['text'], $flags),
            'array' => '[' . implode(',', array_map(self::jsonText(...), $w['array'])) . ']',
            'object' => '{' . implode(',', array_map(
                static fn(array $pair): string => json_encode($pair[0], $flags) . ':' . self::jsonText($pair[1]),
                $w['object']
            )) . '}',
            default => Assert::fail("a $kind wrapper is not a codec value"),
        };
    }

    /** The PHP value of a wrapper in the common value model of COD-16. */
    private static function toValue(array $w): mixed
    {
        $kind = array_key_first($w);
        switch ($kind) {
            case 'nil':
            case 'null':
                return null;
            case 'bool':
                return $w['bool'];
            case 'int':
                return (int) $w['int'];
            case 'float':
                return (float) $w['float'];
            case 'text':
                return $w['text'];
            case 'bytes_hex':
                return new Bytes(hex2bin($w['bytes_hex']));
            case 'array':
                return array_map(self::toValue(...), $w['array']);
            case 'object':
                $out = [];
                foreach ($w['object'] as [$k, $v]) {
                    $out[$k] = self::toValue($v);
                }
                return $out;
        }
        Assert::fail("a $kind wrapper is not a codec value");
    }

    /**
     * Compares a decoded value with a wrapper: an ordered-json value by its number text and member order (COD-16),
     * every other value by number value and with its object as a set of pairs (FCV-4). A PHP array is a list or a map
     * by the wrapper it is compared with, since an array with the keys 0 to n-1 is both.
     */
    private static function equal(mixed $got, array $want, bool $ordered): bool
    {
        $kind = array_key_first($want);
        if ($got instanceof OrderedJson) {
            return self::equalJson($got, $want);
        }
        return match ($kind) {
            'nil' => $got === null,
            'bool' => $got === $want['bool'],
            'int' => is_int($got) && (string) $got === $want['int'],
            'float' => is_float($got) && $got === (float) $want['float'],
            'text' => is_string($got) && $got === $want['text'],
            'bytes_hex' => $got instanceof Bytes && $got->bytes === hex2bin($want['bytes_hex']),
            'array' => is_array($got) && array_is_list($got) && count($got) === count($want['array'])
                && self::all($want['array'], static fn(array $w, int $i): bool => self::equal($got[$i], $w, $ordered)),
            'object' => is_array($got) && count($got) === count($want['object'])
                && self::all($want['object'], static fn(array $pair): bool => array_key_exists($pair[0], $got)
                    && self::equal($got[$pair[0]], $pair[1], $ordered)),
            default => false,
        };
    }

    private static function equalJson(OrderedJson $got, array $want): bool
    {
        $kind = array_key_first($want);
        return match ($got->kind()) {
            Kind::Null->value => $kind === 'nil',
            Kind::Boolean->value => $kind === 'bool' && $got->booleanValue() === $want['bool'],
            Kind::String->value => $kind === 'text' && $got->stringValue() === $want['text'],
            Kind::Number->value => ($kind === 'int' || $kind === 'float')
                && ($kind === 'float') === (strpbrk($got->numberLiteral(), '.eE') !== false)
                && $got->numberLiteral() === $want[$kind],
            Kind::Array->value => $kind === 'array' && count($got->items()) === count($want['array'])
                && self::all(
                    $want['array'],
                    static fn(array $w, int $i): bool => self::equalJson($got->items()[$i], $w)
                ),
            Kind::Object->value => $kind === 'object' && self::orderedMembers($got) === array_column($want['object'], 0)
                && self::all(
                    $want['object'],
                    static fn(array $pair): bool => self::equalJson($got->get($pair[0]), $pair[1])
                ),
            default => false,
        };
    }

    /** @return list<string> the member names of an ordered-json object in order */
    private static function orderedMembers(OrderedJson $object): array
    {
        return array_map('strval', array_keys($object->members()));
    }

    private static function all(array $items, callable $check): bool
    {
        foreach ($items as $index => $item) {
            if (!$check($item, $index)) {
                return false;
            }
        }
        return true;
    }

    private static function shown(mixed $value): string
    {
        if ($value instanceof OrderedJson) {
            return \Polyspec\OrderedJson\stringify($value);
        }
        if ($value instanceof Bytes) {
            return 'bytes(' . bin2hex($value->bytes) . ')';
        }
        return var_export($value, true);
    }
}
