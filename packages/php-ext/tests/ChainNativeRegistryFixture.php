<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

final class ChainNativeRegistryFixture
{
    public static function meta(): array
    {
        return [
            'entity' => 'chain_native_fixture',
            'manifest_hash' => 'sha256:' . hash('sha256', "dbspec 1\n"),
            'columns' => ['seq' => ['type' => 'i64', 'codec' => []]],
        ];
    }
}
