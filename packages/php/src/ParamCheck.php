<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/**
 * A parameter is checked against the logical type of each slot it fills before any statement (docs/spec/protocol.md §5
 * "Parameters"): the SQL bind path reads the slot of the plan step, an IR executor the uses of Validator::paramUses.
 * A slot type is [type, precision, scale, length]: a dbspec type kind with the precision of a decimal, time or
 * datetime, the scale of a decimal and the length of a varchar.
 *
 * @internal
 */
final class ParamCheck
{
    private const INTEGER_RANGES = [
        'i16' => [-32768, 32767],
        'i32' => [-2147483648, 2147483647],
        'i64' => [PHP_INT_MIN, PHP_INT_MAX],
    ];

    /**
     * The logical type of a param bind slot of a plan step.
     *
     * @param array<string, mixed> $slot
     * @return array{type: string, precision: int, scale: int, length: int}
     */
    public static function bindSlotType(array $slot): array
    {
        return [
            'type' => (string) ($slot['col_type'] ?? ''),
            'precision' => (int) ($slot['precision'] ?? 0),
            'scale' => (int) ($slot['scale'] ?? 0),
            'length' => (int) ($slot['length'] ?? 0),
            'not_null' => (bool) ($slot['not_null'] ?? false),
            'column' => (string) ($slot['column'] ?? ''),
        ];
    }

    /**
     * The logical type of a parameter use: a use of its column's type takes the column's precision, scale and length;
     * a datetime or time of a function takes six digits.
     *
     * @param array{type: string, column: ?array} $use
     * @return array{type: string, precision: int, scale: int, length: int}
     */
    public static function useSlotType(array $use): array
    {
        $col = $use['column'];
        if ($col !== null && $col['type'] === $use['type']) {
            return ['type' => $use['type'], 'precision' => $col['precision'] ?? 0, 'scale' => $col['scale'] ?? 0,
                'length' => $col['length'] ?? 0, 'not_null' => ($use['assign'] ?? false) && !$col['nullable'],
                'column' => $col['name']];
        }
        return ['type' => $use['type'],
            'precision' => in_array($use['type'], ['datetime', 'time'], true) ? 6 : 0, 'scale' => 0, 'length' => 0];
    }

    /**
     * Refuses SQL NULL as parameter $i when $slot assigns a non-null column; it runs for every slot before
     * any statement.
     *
     * @param array{not_null?: bool, column?: string} $slot
     */
    public static function checkAssign(int $i, mixed $v, array $slot): void
    {
        if ($v === null && ($slot['not_null'] ?? false)) {
            throw new OrmException(Code::CODEC_ENCODE,
                "parameter $i assigns NULL to the non-null " . ($slot['column'] ?? ''));
        }
    }

    /**
     * Checks the value of parameter $i against the logical type of a slot it fills: the host value kind,
     * the range of an integer, a finite f64, the precision and scale of a decimal, a date from 0001-01-01
     * to 9999-12-31, no non-zero digit of a time or datetime past its precision, at most n characters of a
     * varchar(n), no U+0000 in text and a lower-case canonical uuid. A value outside it is CODEC_ENCODE;
     * SQL NULL is accepted.
     *
     * @param array{type: string, precision: int, scale: int, length: int} $slot
     */
    public static function check(int $i, mixed $v, array $slot, \DateTimeZone $zone): void
    {
        if ($v === null) {
            return;
        }
        $type = $slot['type'];
        $kind = static fn(): OrmException => new OrmException(Code::CODEC_ENCODE,
            "parameter $i (" . get_debug_type($v) . ") is not a $type value");
        switch ($type) {
            case 'i16':
            case 'i32':
            case 'i64':
                if (!is_int($v)) {
                    throw $kind();
                }
                [$low, $high] = self::INTEGER_RANGES[$type];
                if ($v < $low || $v > $high) {
                    throw new OrmException(Code::CODEC_ENCODE, "parameter $i ($v) is outside $type");
                }
                return;
            case 'f64':
                if (!is_int($v) && !is_float($v)) {
                    throw $kind();
                }
                if (is_float($v) && !is_finite($v)) {
                    throw new OrmException(Code::CODEC_ENCODE,
                        "parameter $i (" . var_export($v, true) . ') is not a finite f64');
                }
                return;
            case 'bool':
                if (!is_bool($v)) {
                    throw $kind();
                }
                return;
            case 'decimal':
                if (!is_string($v)) {
                    throw $kind();
                }
                try {
                    Decimal::normalize($v, $slot['precision'], $slot['scale']);
                } catch (OrmException $e) {
                    throw new OrmException(Code::CODEC_ENCODE, "parameter $i: " . $e->getMessage(), $e);
                }
                return;
            case 'varchar':
            case 'text':
            case 'uuid':
                if (!is_string($v)) {
                    throw $kind();
                }
                $n = preg_match_all('/./su', $v);
                if ($n === false) {
                    throw $kind();
                }
                if (str_contains($v, "\0")) {
                    throw new OrmException(Code::CODEC_ENCODE, "parameter $i holds U+0000, which no $type value holds");
                }
                if ($type === 'varchar' && $slot['length'] > 0 && $n > $slot['length']) {
                    throw new OrmException(Code::CODEC_ENCODE,
                        "parameter $i has $n characters, more than varchar({$slot['length']})");
                }
                if ($type === 'uuid'
                    && preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/D', $v) !== 1) {
                    throw new OrmException(Code::CODEC_ENCODE,
                        "parameter $i (\"$v\") is not a lower-case canonical uuid");
                }
                return;
            case 'bytes':
                if (!is_string($v) && !$v instanceof Bytes) {
                    throw $kind();
                }
                return;
            case 'date':
            case 'time':
            case 'datetime':
                if (!is_string($v)) {
                    throw $kind();
                }
                try {
                    $text = Db::timeValue($v, $type, $slot['precision'], $zone);
                } catch (OrmException $e) {
                    throw new OrmException(Code::CODEC_ENCODE, "parameter $i: " . $e->getMessage(), $e);
                }
                if ($type !== 'time' && (!is_string($text) || preg_match('/^\d{4}-/', $text) !== 1
                    || str_starts_with($text, '0000'))) {
                    $shown = "\"$v\"";
                    throw new OrmException(Code::CODEC_ENCODE,
                        "parameter $i ($shown) is outside 0001-01-01 to 9999-12-31");
                }
                return;
        }
    }
}
