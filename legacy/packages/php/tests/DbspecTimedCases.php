<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

trait DbspecTimedCases
{
    private static array $started;

    abstract protected static function timingName(): string;

    public static function setUpBeforeClass(): void
    {
        self::$started = caseClockStart();
    }

    public static function tearDownAfterClass(): void
    {
        [$cpuMs, $wallMs] = caseClockElapsed(self::$started);
        if ($cpuMs > 10000) {
            caseClockWarning(
                sprintf(
                    '%s used %.3f ms of CPU (%.3f ms wall), above its reference of 10 s',
                    static::timingName(),
                    $cpuMs,
                    $wallMs
                )
            );
        }
    }
}
