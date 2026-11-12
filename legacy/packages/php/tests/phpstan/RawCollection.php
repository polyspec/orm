<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests\Phpstan;

use Polyspec\Orm\Collection;

function seqs(Collection $rows): array
{
    $out = [];
    foreach ($rows as $r) {
        $out[] = $r->getSeq();
    }
    return $out;
}
