<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

final class CatalogMetadataFailurePdo extends UninitializedRecordingPdo
{
    public function prepare(string $query, array $options = []): \PDOStatement|false
    {
        return new CatalogMetadataFailureStatement();
    }
}
