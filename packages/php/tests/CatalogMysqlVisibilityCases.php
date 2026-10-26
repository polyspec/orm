<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use Polyspec\Orm\Catalog;
use Polyspec\Orm\CatalogColumn;
use Polyspec\Orm\CatalogTableMetadata;
use Polyspec\Orm\Code;
use Polyspec\Orm\OrmException;

final class CatalogMysqlVisibilityCases
{
    /** @param callable(CatalogMysqlVisibilityPdo): Catalog $makeCatalog */
    public static function assertPublicInsert(callable $makeCatalog): void
    {
        $metadata = new CatalogTableMetadata(
            ['namespace' => 'app', 'name' => 'visibility_probe'],
            'table',
            [
                new CatalogColumn('id', 'BIGINT', false, false, false, null, false),
                new CatalogColumn('value', 'VARCHAR(32)', false, false, false, null, false),
            ],
            ['id'],
            true,
        );
        $directPdo = new CatalogMysqlVisibilityPdo(0, true);
        $result = $makeCatalog($directPdo)->insertRow($metadata, ['id' => 1, 'value' => 'visible']);
        Assert::assertSame([[1, 'visible']], $result->rows);
        Assert::assertContains('SELECT CURRENT_USER()', $directPdo->queries);
        Assert::assertContains(
            true,
            array_map(
                static fn (string $query): bool => str_contains($query, 'information_schema.USER_PRIVILEGES'),
                $directPdo->queries,
            ),
        );
        Assert::assertContains(
            true,
            array_map(static fn (string $query): bool => str_starts_with($query, 'INSERT INTO'), $directPdo->queries),
        );

        foreach (
            [
                'role-only grant' => [0, false],
                'enabled partial revokes' => [1, true],
            ] as $scenario => [$partialRevokes, $directGrant]
        ) {
            $pdo = new CatalogMysqlVisibilityPdo($partialRevokes, $directGrant);
            try {
                $makeCatalog($pdo)->insertRow($metadata, ['id' => 1, 'value' => 'visible']);
                Assert::fail($scenario . ' was accepted by the public row insertion');
            } catch (OrmException $error) {
                Assert::assertSame(Code::ROW_MUTATION_UNSUPPORTED, $error->code_);
            }
            Assert::assertNotContains(
                true,
                array_map(static fn (string $query): bool => str_starts_with($query, 'INSERT INTO'), $pdo->queries),
            );
            if ($partialRevokes === 1) {
                Assert::assertNotContains('SELECT CURRENT_USER()', $pdo->queries);
            } else {
                Assert::assertContains(
                    true,
                    array_map(
                        static fn (string $query): bool => str_contains($query, 'information_schema.USER_PRIVILEGES'),
                        $pdo->queries,
                    ),
                );
            }
        }
    }
}
