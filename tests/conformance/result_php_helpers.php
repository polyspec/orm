<?php
declare(strict_types=1);

/** Convert a derived numeric column to the integer written in a vector result. */
function derivedInteger(mixed $value): int
{
    if (is_int($value)) return $value;
    if (is_float($value) && is_finite($value) && floor($value) === $value && $value >= -9_223_372_036_854_775_808.0 && $value < 9_223_372_036_854_775_808.0) {
        return (int) $value;
    }
    if (is_string($value) && preg_match('/^-?(?:0|[1-9][0-9]*)$/D', $value) === 1) {
        $parsed = filter_var($value, FILTER_VALIDATE_INT);
        if ($parsed !== false) return $parsed;
    }
    throw new InvalidArgumentException('invalid derived integer');
}

/** Keep an unexpected vector failure visible to the caller. */
function executeVector(string $name, callable $fn, ?callable $transaction = null): mixed
{
    try {
        return $transaction === null ? $fn() : $transaction($fn);
    } catch (Throwable $error) {
        throw new RuntimeException("conformance vector {$name} failed: {$error->getMessage()}", 0, $error);
    }
}
