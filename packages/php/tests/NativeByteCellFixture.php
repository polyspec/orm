<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Model;

final class NativeByteCellFixture extends Model
{
    public static function meta(): array
    {
        return [
            'entity' => 'native_byte_cell',
            'updated' => '',
            'columns' => [
                'body' => ['type' => 'bytes', 'codec' => [], 'nullable' => true],
                'ratio' => ['type' => 'f64', 'codec' => [], 'nullable' => true],
                'row_count' => ['type' => 'f64', 'codec' => [], 'nullable' => true],
            ],
        ];
    }
}
