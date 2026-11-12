<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Model;

final class ModelStreamFixture extends Model
{
    public static function meta(): array
    {
        return [
            'entity' => 'stream_fixture',
            'updated' => '',
            'columns' => [
                'title' => ['type' => 'text', 'codec' => [], 'nullable' => true],
                'active' => ['type' => 'bool', 'codec' => [], 'nullable' => true],
                'body' => ['type' => 'bytes', 'codec' => [], 'nullable' => true],
            ],
        ];
    }
}
