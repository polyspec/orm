<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

final class RuntimeModelBadGeneratedFixture
{
    public static function meta(): array
    {
        $meta = RuntimeModelGeneratedFixture::meta();
        $meta['columns']['id']['type'] = 'i32';
        return $meta;
    }
}
