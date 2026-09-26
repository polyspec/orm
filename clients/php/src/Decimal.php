<?php
declare(strict_types=1);

namespace Orm;

final class Decimal
{
    public static function scaled(string $input, int $precision, int $scale): int
    {
        $canonical = self::normalize($input, $precision, $scale);
        $digits = str_replace('.', '', $canonical);
        // normalize() limits the magnitude to 18 digits. PHP integers hold that
        // range, including values whose fractional leading zeroes remain here.
        return (int) $digits;
    }

    public static function fromScaled(mixed $value, int $precision, int $scale): string
    {
        if (!is_int($value) && !(is_string($value) && preg_match('/\A-?[0-9]+\z/', $value) === 1)) {
            throw new OrmException(Code::CODEC_DECODE, 'decimal scaled cell requires an integer');
        }
        $digits = (string) $value;
        $negative = str_starts_with($digits, '-');
        if ($negative) {
            $digits = substr($digits, 1);
        }
        if ($scale > 0) {
            $digits = str_pad($digits, $scale + 1, '0', STR_PAD_LEFT);
            $digits = substr($digits, 0, -$scale) . '.' . substr($digits, -$scale);
        }
        return self::decode(($negative ? '-' : '') . $digits, $precision, $scale);
    }

    public static function decode(mixed $value, int $precision, int $scale): string
    {
        if (!is_string($value)) {
            throw new OrmException(Code::CODEC_DECODE, 'decimal cell requires exact text');
        }
        try {
            return self::normalize($value, $precision, $scale);
        } catch (OrmException $error) {
            throw new OrmException(Code::CODEC_DECODE, "invalid decimal cell: {$error->getMessage()}");
        }
    }

    public static function normalize(string $input, int $precision, int $scale): string
    {
        $fail = static fn(string $reason): OrmException => new OrmException(Code::CODEC_ENCODE, "decimal $input: $reason");
        if ($precision < 1 || $precision > 18 || $scale < 0 || $scale > $precision) {
            throw $fail('invalid precision or scale');
        }
        if (preg_match('/\A[+-]?[0-9]+(?:\.[0-9]+)?\z/', $input) !== 1) {
            throw $fail('invalid text');
        }
        $negative = str_starts_with($input, '-');
        $unsigned = str_starts_with($input, '-') || str_starts_with($input, '+') ? substr($input, 1) : $input;
        $parts = explode('.', $unsigned, 2);
        $whole = ltrim($parts[0], '0');
        $whole = $whole === '' ? '0' : $whole;
        $fraction = $parts[1] ?? '';
        if (strlen($fraction) > $scale) {
            throw $fail('fraction exceeds scale');
        }
        if (($whole === '0' ? 0 : strlen($whole)) + $scale > $precision) {
            throw $fail('value exceeds precision');
        }
        $fraction = str_pad($fraction, $scale, '0');
        if ($whole === '0' && trim($fraction, '0') === '') {
            $negative = false;
        }
        return ($negative ? '-' : '') . $whole . ($scale === 0 ? '' : '.' . $fraction);
    }
}
