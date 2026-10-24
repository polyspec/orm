<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Assembly;
use Polyspec\Orm\Db;
use ReflectionClass;
use ReflectionProperty;

final class ModelAssemblyTestSupport
{
    public static function uninitializedAssembly(): Assembly
    {
        $assembly = (new ReflectionClass(Assembly::class))->newInstanceWithoutConstructor();
        (new ReflectionProperty(Assembly::class, 'db'))->setValue(
            $assembly,
            (new ReflectionClass(Db::class))->newInstanceWithoutConstructor(),
        );
        (new ReflectionProperty(Assembly::class, 'conn'))->setValue($assembly, null);
        (new ReflectionProperty(Assembly::class, 'zone'))->setValue($assembly, new \DateTimeZone('UTC'));
        return $assembly;
    }
}
