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
    ) {
    }
}
