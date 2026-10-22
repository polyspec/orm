<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests\Phpstan;

use Polyspec\Orm\GroupRows;

/**
 * Each row that GroupRows yields is a GroupRow, so a caller can call its methods on it; a mixed row fails the check.
 *
 * @return list<array<string, mixed>>
 */
function rowArrays(GroupRows $groups): array
{
    $out = [];
    foreach ($groups as $row) {
        $out[] = $row->toArray();
    }
    return $out;
}
