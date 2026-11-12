<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Model;

final class DslFixture extends Model
{
    public const MANIFEST = "dbspec 1 dsl_fixture\n\n"
        . "table dsl_fixture {\n"
        . "  id i64 identity\n"
        . "  name text nullable\n"
        . "  age i32 nullable\n"
        . "  primary key (id)\n}\n";

    public static function meta(): array
    {
        return ['entity' => 'dsl_fixture', 'manifest_hash' => 'sha256:' . hash('sha256', self::MANIFEST), 'columns' => [
            'id' => ['type' => 'i64', 'codec' => [], 'nullable' => false],
            'name' => ['type' => 'text', 'codec' => [], 'nullable' => true],
            'age' => ['type' => 'i32', 'codec' => [], 'nullable' => true],
        ], 'indexes' => ['by_name' => ['name']]];
    }
}
