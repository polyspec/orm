<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Model;

final class GroupRowsModelFixture extends Model
{
    public static function meta(): array
    {
        return ['entity' => 'group_rows_fixture'];
    }
}
