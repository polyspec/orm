<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDO;

final class CatalogMetadataFailurePdo extends PDO
{
    /** @var list<string> */
    public array $statements = [];

    public function __construct()
    {
    }

    public function setAttribute(int $attribute, mixed $value): bool
    {
        return true;
    }

    public function exec(string $statement): int|false
    {
        $this->statements[] = $statement;
        return 0;
    }

    public function prepare(string $query, array $options = []): \PDOStatement|false
    {
        return new CatalogMetadataFailureStatement();
    }
}
