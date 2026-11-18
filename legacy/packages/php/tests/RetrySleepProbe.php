<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests {
    /**
     * The count of the calls of usleep by the library (CORE-24): src/ calls usleep unqualified in its namespace, so PHP
     * resolves the call to Polyspec\Orm\usleep below, which counts it and sleeps as the global function does.
     */
    final class RetrySleepProbe
    {
        public static int $calls = 0;
    }
}

namespace Polyspec\Orm {
    if (!\function_exists('Polyspec\Orm\usleep')) {
        function usleep(int $microseconds): void
        {
            \Polyspec\Orm\Tests\RetrySleepProbe::$calls++;
            \usleep($microseconds);
        }
    }
}
