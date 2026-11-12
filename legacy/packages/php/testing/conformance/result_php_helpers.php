<?php

declare(strict_types=1);

/** Keep an unexpected vector failure visible to the caller. */
function executeVector(string $name, callable $fn, ?callable $transaction = null): mixed
{
    try {
        return $transaction === null ? $fn() : $transaction($fn);
    } catch (Throwable $error) {
        throw new RuntimeException("conformance vector {$name} failed: {$error->getMessage()}", 0, $error);
    }
}
