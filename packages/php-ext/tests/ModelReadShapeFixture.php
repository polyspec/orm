<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Model;

final class ModelReadShapeFixture extends Model
{
    public static function meta(): array
    {
        return [
            'entity' => 'read_shape', 'updated' => 'updated_ts',
            'columns' => [
                'title' => ['type' => 'text', 'codec' => [], 'nullable' => true],
                'id' => ['type' => 'i64', 'codec' => []],
                'active' => ['type' => 'bool', 'codec' => []],
                'ratio' => ['type' => 'f64', 'codec' => []],
                'payload' => ['type' => 'text', 'codec' => ['name' => 'json']],
                'updated_ts' => ['type' => 'datetime', 'codec' => []],
            ],
        ];
    }
}
