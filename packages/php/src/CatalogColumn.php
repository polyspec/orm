<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/** One column of a catalog table in physical order. defaultExpression is null when the column has no default. */
final class CatalogColumn
{
    public function __construct(
        public readonly string $name,
        public readonly string $nativeType,
        public readonly bool $nullable,
        public readonly bool $generated,
        public readonly bool $automaticKey,
        public readonly ?string $defaultExpression,
        public readonly bool $expressionDefault,
        // On SQLite, the fraction digits that the dbspec CHECK of a TIME or DATETIME column fixes; null when no CHECK
        // fixes them and on the other databases (Go's checkPrecision).
        public readonly ?int $checkPrecision = null,
    ) {
    }
}
