<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/** Canonical literal forms of dbspec defaults, check literals and coordinates. */
final class Literal
{
    private const INTEGER_LIMITS = ['i16' => ['32767', '32768'], 'i32' => ['2147483647', '2147483648'], 'i64' => ['9223372036854775807', '9223372036854775808']];

    /** Splits `-?digits(.digits)?` into its sign, integer digits and fraction digits, or null. */
    public static function number(string $text): ?array
    {
        if (!preg_match('/^(-?)([0-9]+)(?:\.([0-9]+))?$/D', $text, $m)) {
            return null;
        }
        return [$m[1] === '-', $m[2], $m[3] ?? null];
    }

    /** An integer without a sign for zero or leading zeros, or null. */
    public static function integer(string $text): ?string
    {
        $n = self::number($text);
        if ($n === null || $n[2] !== null) {
            return null;
        }
        $digits = ltrim($n[1], '0');
        return $digits === '' ? '0' : ($n[0] ? '-' : '') . $digits;
    }

    /** A single-quoted string token's value, or null when the token is not a string. */
    public static function stringValue(string $token): ?string
    {
        if (strlen($token) < 2 || $token[0] !== "'" || $token[strlen($token) - 1] !== "'") {
            return null;
        }
        return str_replace("''", "'", substr($token, 1, -1));
    }

    public static function quote(string $value): string
    {
        return "'" . str_replace("'", "''", $value) . "'";
    }

    /**
     * The canonical default of a column type for a literal text, or an error message.
     *
     * @return array{0: ?string, 1: ?string} [canonical text, error]
     */
    public static function columnDefault(ColumnType $type, string $text): array
    {
        $name = $type->name;
        if ($text === 'now') {
            return $name === 'datetime' ? ['now', null] : [null, '`now` is a default of a datetime column only'];
        }
        if ($type->isInteger()) {
            $canonical = self::integer($text);
            if ($canonical === null) {
                return [null, "$name default is not an integer"];
            }
            [$max, $minMagnitude] = self::INTEGER_LIMITS[$name];
            $negative = $canonical[0] === '-';
            $digits = ltrim($canonical, '-');
            $limit = $negative ? $minMagnitude : $max;
            if (strlen($digits) > strlen($limit) || (strlen($digits) === strlen($limit) && strcmp($digits, $limit) > 0)) {
                return [null, "$name default is out of range"];
            }
            return [$canonical, null];
        }
        switch ($name) {
            case 'bool':
                return $text === 'true' || $text === 'false' ? [$text, null] : [null, 'bool default is not true or false'];
            case 'decimal':
                [$precision, $scale] = $type->parameters;
                $n = self::number($text);
                if ($n === null) {
                    return [null, 'decimal default is not a number'];
                }
                $digits = ltrim($n[1], '0');
                $fraction = $n[2] ?? '';
                if (strlen($digits) > $precision - $scale) {
                    return [null, "decimal default has more than " . ($precision - $scale) . ' integer digits'];
                }
                if (strlen($fraction) > $scale) {
                    return [null, "decimal default has more than $scale fraction digits"];
                }
                $zero = $digits === '' && trim($fraction, '0') === '';
                return [($n[0] && !$zero ? '-' : '') . ($digits === '' ? '0' : $digits) . ($scale > 0 ? '.' . str_pad($fraction, $scale, '0') : ''), null];
            case 'f64':
                if (self::number($text) === null) {
                    return [null, 'f64 default is not a number'];
                }
                $value = (float) $text;
                if (!is_finite($value)) {
                    return [null, 'f64 default is not a finite double'];
                }
                return [self::shortestDecimal($value), null];
            case 'text':
            case 'bytes':
                return [null, "a $name column has no default"];
        }
        $value = self::stringValue($text);
        if ($value === null) {
            return [null, "$name default is not a quoted string"];
        }
        switch ($name) {
            case 'varchar':
                if (str_contains($value, "\0")) {
                    return [null, 'varchar default contains U+0000'];
                }
                if (mb_strlen($value, 'UTF-8') > $type->parameters[0]) {
                    return [null, 'varchar default is longer than ' . $type->parameters[0] . ' characters'];
                }
                return [self::quote($value), null];
            case 'uuid':
                if (!preg_match('/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/D', $value)) {
                    return [null, 'uuid default is not canonical uuid text'];
                }
                return [self::quote(strtolower($value)), null];
            case 'date':
                return self::date($value) ? [self::quote($value), null] : [null, 'date default is not a date from 0001-01-01 to 9999-12-31'];
            case 'time':
                $time = self::time($value, $type->parameters[0]);
                return $time === null ? [null, 'time default is not a time of day with at most ' . $type->parameters[0] . ' fraction digits'] : [self::quote($time), null];
            case 'datetime':
                $time = strlen($value) > 11 && $value[10] === ' ' && self::date(substr($value, 0, 10)) ? self::time(substr($value, 11), $type->parameters[0]) : null;
                return $time === null ? [null, 'datetime default is not a date-time with at most ' . $type->parameters[0] . ' fraction digits'] : [self::quote(substr($value, 0, 11) . $time), null];
        }
        throw new \LogicException("Unknown column type $name");
    }

    /**
     * The shortest decimal without exponent that reads back as the same
     * double, without a point for an integral value, and `0` for negative zero.
     */
    public static function shortestDecimal(float $value): string
    {
        if ($value == 0.0) {
            return '0';
        }
        for ($precision = 0; $precision < 17; $precision++) {
            $scientific = sprintf('%.' . $precision . 'e', $value);
            if ((float) $scientific === $value) {
                break;
            }
        }
        preg_match('/^(-?)([0-9])(?:\.([0-9]+))?e([+-][0-9]+)$/D', $scientific, $m);
        $digits = rtrim($m[2] . ($m[3] ?? ''), '0');
        $point = 1 + (int) $m[4];
        if ($point <= 0) {
            $plain = '0.' . str_repeat('0', -$point) . $digits;
        } elseif ($point >= strlen($digits)) {
            $plain = $digits . str_repeat('0', $point - strlen($digits));
        } else {
            $plain = substr($digits, 0, $point) . '.' . substr($digits, $point);
        }
        return $m[1] . $plain;
    }

    private static function date(string $value): bool
    {
        return preg_match('/^([0-9]{4})-([0-9]{2})-([0-9]{2})$/D', $value, $m) === 1
            && (int) $m[1] >= 1 && checkdate((int) $m[2], (int) $m[3], (int) $m[1]);
    }

    /** `HH:MM:SS[.f]` below 24:00:00 with at most `$precision` fraction digits, padded to exactly that many. */
    private static function time(string $value, int $precision): ?string
    {
        if (!preg_match('/^([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?$/D', $value, $m)) {
            return null;
        }
        $fraction = $m[4] ?? '';
        if ((int) $m[1] > 23 || (int) $m[2] > 59 || (int) $m[3] > 59 || strlen($fraction) > $precision) {
            return null;
        }
        return "$m[1]:$m[2]:$m[3]" . ($precision > 0 ? '.' . str_pad($fraction, $precision, '0') : '');
    }
}
