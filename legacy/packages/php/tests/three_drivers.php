<?php

// The three SQL drivers of a test class: each driver is one data set of the class's test, as the classes that run on
// every driver declare them (KSTD-5-46).

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

trait ThreeDrivers
{
    /** @return iterable<string, array{string}> the drivers of the case, each a data set */
    public static function drivers(): iterable
    {
        foreach (['sqlite', 'mysql', 'postgres'] as $driver) {
            yield $driver => [$driver];
        }
    }
}
